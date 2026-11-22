import { NextRequest, NextResponse } from "next/server";

import { runWithAiProvider, type AiExecutionResult } from "@/lib/ai-providers";
import { runLimitedAi } from "@/lib/flash-assist";
import { demoLoginEnabled } from "@/lib/pilot-auth";
import { isYandexAiConfigured } from "@/lib/yandex-ai";
import { JsonBodyError, readBoundedJson } from "@/lib/http-json";
import {
  flattenArticleChunks,
  isApprovedArticle,
} from "@/lib/articles";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import {
  buildArticleMessages,
  buildDeterministicArticleDraft,
  buildNoDataDraft,
  extractJsonObject,
  getBasisChunks,
  groundGeneratedArticle,
  isGroundedArticleText,
  normalizeGeneratedArticle,
  selectRelevantArticles,
  selectRelevantCards,
  selectUniversityMetricCards,
} from "@/lib/editor";
import type { KnowledgeCard } from "@/lib/knowledge";
import { getCardVersionId } from "@/lib/knowledge-versions";
import {
  getAllArticles,
  getCanonicalKnowledgeCards,
} from "@/lib/models";
import { generateArticleInputSchema } from "@/lib/validation/articles";

function sourceSummary(card: KnowledgeCard) {
  return {
    id: card.id,
    title: card.title,
    type: card.type,
    description: card.referenceDescription,
  };
}

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request))
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );
  const user = await getSessionUser();
  if (!user)
    return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  if (user.role === "guest")
    return NextResponse.json(
      { error: "Гостям недоступна подготовка черновиков" },
      { status: 403 }
    );
  let body: unknown;

  try {
    body = await readBoundedJson(request, 256 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: error instanceof JsonBodyError ? error.status : 400 }
    );
  }

  const parsed = generateArticleInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Опишите задачу подробнее",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const { query, basis, provider, audience, outlet, length } = parsed.data;
  const data = await Promise.all([getCanonicalKnowledgeCards(), getAllArticles()]).catch(() => null);
  if (!data) return unavailableStorageResponse();
  const [cards, articles] = data;

  const metricCards = selectUniversityMetricCards(query, cards);
  if (
    metricCards &&
    !metricCards.some((card) => card.structuredMetrics.length)
  ) {
    return NextResponse.json(
      buildNoDataDraft({
        query,
        message:
          "В утверждённых паспортах вузов нет подтверждённых показателей по этому запросу. Уточните вуз и период или запросите документ у владельца карточки.",
      })
    );
  }

  const basisArticle =
    !metricCards && basis
      ? articles.find(
          (article) =>
            article.id === basis.articleId && isApprovedArticle(article)
        )
      : undefined;
  const basisChunks = getBasisChunks(basisArticle, basis?.chunkIds);

  const selectedCards: KnowledgeCard[] =
    metricCards ?? selectRelevantCards(cards, query).map((item) => item.card);

  if (basisArticle) {
    basisArticle.sourceCardIds.forEach((cardId) => {
      const card = cards.find((item) => item.id === cardId);
      if (card && !selectedCards.some((item) => item.id === card.id)) {
        selectedCards.push(card);
      }
    });
  }

  if (selectedCards.length === 0) {
    return NextResponse.json(
      buildNoDataDraft({
        query,
        message:
          "В официальных данных нет сведений по этому запросу. Уточните вуз, проект или тему: умный редактор не использует общие знания модели и не придумывает факты.",
      })
    );
  }

  const matchedArticles = metricCards
    ? []
    : selectRelevantArticles(articles.filter(isApprovedArticle), query).filter(
        (article) => article.id !== basisArticle?.id
      );
  const sourceArticles = basisArticle
    ? [basisArticle, ...matchedArticles]
    : matchedArticles;

  const referenceChunks = [
    ...basisChunks,
    ...matchedArticles.flatMap((article) => flattenArticleChunks(article)),
  ]
    .slice(0, 10)
    .filter((chunk) => {
      const article = sourceArticles.find(
        (item) => item.id === chunk.articleId
      );
      const sourceCards = selectedCards.filter((card) =>
        article?.sourceCardIds.includes(card.id)
      );
      return (
        sourceCards.length > 0 &&
        isGroundedArticleText(chunk.content, sourceCards)
      );
    });
  const usedArticles = sourceArticles.filter((article) =>
    referenceChunks.some((chunk) => chunk.articleId === article.id)
  );

  const messages = buildArticleMessages({
      query: [
        query,
        audience && `Аудитория: ${audience}`,
        outlet && `Площадка: ${outlet}`,
        length && `Желаемый объём: ${length}`,
      ]
        .filter(Boolean)
        .join("\n"),
      cards: selectedCards,
      referenceChunks,
    });
  const selectedProvider = metricCards || demoLoginEnabled() ? "canonical" : provider;
  let execution: AiExecutionResult;
  if (selectedProvider !== "canonical" && selectedProvider !== "alibaba" && isYandexAiConfigured()) {
    const limited = await runLimitedAi(request, user.id, signal => runWithAiProvider(messages, selectedProvider, { signal, temperature: 0.05, maxTokens: 4000 }));
    execution = limited.status === "ready" ? limited.value : {
      text: null, provider: "canonical", modelLabel: "Сборка по утверждённым карточкам",
      latencyMs: 0, anonymized152FZ: false,
      fallbackReason: limited.status === "busy" ? "ИИ занят или ещё действует интервал между запросами. Подготовлен черновик по карточкам." : "ИИ недоступен. Подготовлен черновик по карточкам.",
    };
  } else execution = await runWithAiProvider(messages, selectedProvider, { signal: request.signal });
  if (execution.text) {
    const latest = await getCanonicalKnowledgeCards().catch(() => null);
    if (!latest) return unavailableStorageResponse();
    if (selectedCards.some(source => !latest.some(card => card.id === source.id && getCardVersionId(card) === getCardVersionId(source)))) {
      return NextResponse.json({ error: "Карточки изменились во время генерации. Повторите запрос, чтобы использовать актуальные сведения." }, { status: 409 });
    }
  }

  let articlePayload = null;
  let fallbackReason = execution.fallbackReason;
  let actualProvider = execution.provider;
  let modelLabel = execution.modelLabel;

  if (execution.text) {
    try {
      const raw = extractJsonObject(execution.text);

      if (
        raw &&
        typeof raw === "object" &&
        (raw as Record<string, unknown>).noData === true
      ) {
        return NextResponse.json(
          buildNoDataDraft({
            query,
            message:
              "В официальных данных нет достаточных сведений по запросу.",
          })
        );
      }

      const candidate = normalizeGeneratedArticle(raw, {
        selectedCards,
        matchedArticles: usedArticles,
      });
      const reason = groundGeneratedArticle(candidate, selectedCards);
      if (reason) {
        actualProvider = "canonical";
        modelLabel = "Подготовка по проверенным фактам";
        fallbackReason = reason;
      } else {
        articlePayload = candidate;
      }
    } catch (parseError) {
      actualProvider = "canonical";
      modelLabel =
        "Подготовка по проверенным фактам (резерв после некорректного JSON модели)";
      fallbackReason =
        parseError instanceof Error
          ? parseError.message
          : "Модель вернула некорректную структуру — использована строгая сборка по карточкам.";
    }
  }

  if (!articlePayload) {
    try {
      articlePayload = buildDeterministicArticleDraft({
        query,
        selectedCards,
        matchedArticles: usedArticles,
        referenceChunks,
      });
    } catch {
      return NextResponse.json(
        { error: "Не удалось собрать черновик из выбранных источников. Уточните тему или выберите меньше блоков." },
        { status: 422 }
      );
    }
  }

  const sourceCardIds = [...new Set(articlePayload.sourceCardIds)];
  const canonicalSources = sourceCardIds
    .map((cardId) => cards.find((card) => card.id === cardId))
    .filter((card): card is KnowledgeCard => Boolean(card));
  if (canonicalSources.length !== sourceCardIds.length) {
    return unavailableStorageResponse();
  }
  // Metric selection projects a passport to the requested years and measures.
  // Its version still identifies the complete approved passport.
  const sources = canonicalSources.map(sourceSummary);
  const sourceVersions = canonicalSources.map((card) => ({
    cardId: card.id,
    versionId: getCardVersionId(card),
  }));

  return NextResponse.json({
    noData: false,
    noDataMessage: null,
    query,
    article: { ...articlePayload, query, sourceVersions },
    sources,
    usedArticles: usedArticles.map((item) => ({
      id: item.id,
      title: item.title,
    })),
    providerMeta: {
      provider: actualProvider,
      modelLabel,
      latencyMs: execution.latencyMs,
      anonymized152FZ: execution.anonymized152FZ,
      fallbackReason,
    },
  });
}
