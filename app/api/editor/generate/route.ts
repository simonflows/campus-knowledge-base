import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { runWithAiProvider, type AiExecutionResult } from "@/lib/ai-providers";
import { runLimitedAi } from "@/lib/flash-assist";
import { demoLoginEnabled } from "@/lib/pilot-auth";
import { isYandexAiConfigured } from "@/lib/yandex-ai";
import { JsonBodyError, readBoundedJson } from "@/lib/http-json";
import {
  articleBasisReference,
  flattenArticleChunks,
  isApprovedArticle,
} from "@/lib/articles";
import { verifySameOrigin } from "@/lib/auth-server";
import { readRouteSession } from "@/lib/account-route-session";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import {
  buildArticleMessages,
  buildDeterministicArticleDraft,
  buildNoDataDraft,
  extractJsonObject,
  getBasisChunks,
  groundGeneratedArticle,
  isBasisOnlyArticleRequest,
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
  getArticleById,
  getCanonicalKnowledgeCards,
} from "@/lib/models";
import { generateArticleInputSchema } from "@/lib/validation/articles";
import { articleBasisRequestSchema } from "@/lib/validation/editor-basis";

const versionedInputSchema = generateArticleInputSchema.extend({
  query: z.string().trim().max(2_000, "Слишком длинный запрос").default(""),
  basis: articleBasisRequestSchema.optional(),
}).refine(({ query, basis }) => Boolean(basis) || query.length >= 10, {
  path: ["query"],
  message: "Опишите задачу подробнее",
});
const privateHeaders = { "Cache-Control": "private, no-store" };

function unavailableBasis(detail: string, status: number) {
  return NextResponse.json({ error: detail }, { status, headers: privateHeaders });
}

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
  const session = await readRouteSession();
  if (session.response) return session.response;
  const user = session.user;
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

  const parsed = versionedInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues.some(issue => issue.path[0] === "basis")
          ? "Снова выберите утверждённый блок в библиотеке, чтобы указать его редакцию."
          : "Опишите задачу подробнее",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const { query, basis, provider, audience, outlet, length } = parsed.data;
  const data = await Promise.all([getCanonicalKnowledgeCards(), getAllArticles()]).catch(() => null);
  if (!data) return unavailableStorageResponse();
  const [cards, articles] = data;

  const basisArticle = basis ? articles.find((article) =>
    article.id === basis.articleId && isApprovedArticle(article)
  ) : undefined;
  if (basis && !basisArticle)
    return unavailableBasis("Утверждённая статья недоступна. Выберите другой блок в библиотеке.", 404);
  if (basis && basisArticle?.approval?.revisionId !== basis.revisionId)
    return unavailableBasis("Статья обновилась. Выберите блок из её актуальной редакции.", 409);
  const basisChunks = getBasisChunks(basisArticle, basis?.chunkIds);
  if (basis && (basisChunks.length !== basis.chunkIds.length ||
    new Set(basisChunks.map((chunk) => chunk.chunkId)).size !== basis.chunkIds.length))
    return unavailableBasis("Выбранный блок отсутствует в утверждённой редакции.", 422);

  const basisOnly = basisArticle && isBasisOnlyArticleRequest(query);
  const draftingQuery = basisOnly ? basisArticle.title : query;
  const metricCards = basisOnly ? null : selectUniversityMetricCards(query, cards);
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

  const selectedCards: KnowledgeCard[] = basisOnly
    ? cards.filter((card) => basisArticle.sourceCardIds.includes(card.id))
    : metricCards ?? selectRelevantCards(cards, query).map((item) => item.card);

  if (selectedCards.length === 0) {
    return NextResponse.json(
      buildNoDataDraft({
        query,
        message:
          "В официальных данных нет сведений по этому запросу. Уточните вуз, проект или тему: умный редактор не использует общие знания модели и не придумывает факты.",
      })
    );
  }

  const matchedArticles = metricCards || basisArticle
    ? []
    : selectRelevantArticles(articles.filter(isApprovedArticle), query);
  const sourceArticles = basisArticle
    ? [basisArticle, ...matchedArticles]
    : matchedArticles;

  const referenceChunks = [
    ...basisChunks,
    ...matchedArticles.flatMap((article) => flattenArticleChunks(article)),
  ]
    .filter((chunk) => {
      const article = sourceArticles.find(
        (item) => item.id === chunk.articleId
      );
      const sourceCards = selectedCards.filter((card) =>
        article?.sourceCardIds.includes(card.id)
      );
      return (
        Boolean(articleBasisReference(chunk)) && sourceCards.length > 0 &&
        isGroundedArticleText(chunk.content, sourceCards)
      );
    })
    .slice(0, 10);
  if (basis && referenceChunks.length !== basisChunks.length)
    return unavailableBasis("Выбранный блок не подтверждается карточками по этой теме. Выберите другую опору или уберите выбранный блок.", 422);
  const usedArticles = sourceArticles.filter((article) =>
    referenceChunks.some((chunk) => chunk.articleId === article.id)
  );

  const messages = buildArticleMessages({
      query: [
        draftingQuery,
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
  if (execution.text || referenceChunks.length) {
    const latest = await Promise.all([
      getCanonicalKnowledgeCards(),
      Promise.all(usedArticles.map(async (article) => [article.id, await getArticleById(article.id)] as const)),
    ]).catch(() => null);
    if (!latest) return unavailableStorageResponse();
    const [currentCards, currentArticles] = latest;
    const originalVersions = new Map(cards.map(card => [card.id, getCardVersionId(card)]));
    const latestVersions = new Map(currentCards.map(card => [card.id, getCardVersionId(card)]));
    if (selectedCards.some(source => latestVersions.get(source.id) !== originalVersions.get(source.id))) {
      return NextResponse.json({ error: "Карточки изменились во время генерации. Повторите запрос, чтобы использовать актуальные сведения." }, { status: 409 });
    }
    const current = new Map(currentArticles);
    const currentBlocks = new Map(currentArticles.map(([id, article]) => [id, article ? flattenArticleChunks(article) : []]));
    if (referenceChunks.some((chunk) => !current.get(chunk.articleId) ||
      !currentBlocks.get(chunk.articleId)?.some((block) => block.chunkId === chunk.chunkId &&
        block.sectionId === chunk.sectionId && block.approvedRevisionId === chunk.approvedRevisionId &&
        block.content === chunk.content && block.sectionHeading === chunk.sectionHeading && block.articleTitle === chunk.articleTitle))) {
      return unavailableBasis("Статья или выбранный блок изменились во время генерации. Обновите библиотеку и повторите запрос.", 409);
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
      const reason = groundGeneratedArticle(candidate, selectedCards, { requireStandaloneLead: true });
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
        query: draftingQuery,
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
  const articleBasis = referenceChunks.flatMap((chunk) => {
    const reference = articleBasisReference(chunk);
    return reference ? [reference] : [];
  });

  return NextResponse.json({
    noData: false,
    noDataMessage: null,
    query,
    article: { ...articlePayload, query, sourceVersions, articleBasis },
    sources,
    usedArticles: usedArticles.map((item) => ({
      id: item.id,
      title: item.title,
      blocks: articleBasis.filter((block) => block.articleId === item.id),
    })),
    providerMeta: {
      provider: actualProvider,
      modelLabel,
      latencyMs: execution.latencyMs,
      anonymized152FZ: execution.anonymized152FZ,
      fallbackReason,
    },
  }, { headers: privateHeaders });
}
