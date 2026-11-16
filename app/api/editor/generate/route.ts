import { NextRequest, NextResponse } from "next/server";

import { runWithAiProvider } from "@/lib/ai-providers";
import { sanitizeCardFor152FZ } from "@/lib/alibaba-ai";
import { flattenArticleChunks, type ReadyArticle } from "@/lib/articles";
import { isStorageWritable } from "@/lib/db";
import {
  buildArticleMessages,
  buildDeterministicArticleDraft,
  buildNoDataDraft,
  extractJsonObject,
  getBasisChunks,
  normalizeGeneratedArticle,
  selectRelevantArticles,
  selectRelevantCards,
} from "@/lib/editor";
import type { KnowledgeCard } from "@/lib/knowledge";
import { mockArticles, mockKnowledgeCards } from "@/lib/mock-data";
import {
  ensureArticleSeed,
  ensureKnowledgeSeed,
  getAllArticles,
  getCanonicalKnowledgeCards,
} from "@/lib/models";
import { generateArticleInputSchema } from "@/lib/validation/articles";

async function loadCards(): Promise<KnowledgeCard[]> {
  if (await isStorageWritable()) {
    try {
      await ensureKnowledgeSeed();
      return await getCanonicalKnowledgeCards();
    } catch (error) {
      console.error("Не удалось загрузить карточки для редактора:", error);
    }
  }

  return mockKnowledgeCards;
}

async function loadArticles(): Promise<ReadyArticle[]> {
  if (await isStorageWritable()) {
    try {
      await ensureArticleSeed();
      return await getAllArticles();
    } catch (error) {
      console.error(
        "Не удалось загрузить готовые статьи для редактора:",
        error
      );
    }
  }

  return mockArticles;
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
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400 }
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

  const { query, basis, provider } = parsed.data;
  const [cards, articles] = await Promise.all([loadCards(), loadArticles()]);

  const basisArticle = basis
    ? articles.find((article) => article.id === basis.articleId)
    : undefined;
  const basisChunks = getBasisChunks(basisArticle, basis?.chunkIds);

  const scoredCards = selectRelevantCards(cards, query);
  const selectedCards = scoredCards.map((item) => item.card);

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
          "В канонических карточках нет сведений по этому запросу. Уточните вуз, проект или тему: умный редактор не использует общие знания модели и не придумывает факты.",
      })
    );
  }

  const matchedArticles = selectRelevantArticles(articles, query).filter(
    (article) => article.id !== basisArticle?.id
  );

  const referenceChunks = [
    ...basisChunks,
    ...matchedArticles.flatMap((article) => flattenArticleChunks(article)),
  ].slice(0, 10);

  const promptCards =
    provider === "alibaba"
      ? selectedCards.map(sanitizeCardFor152FZ)
      : selectedCards;

  const execution = await runWithAiProvider(
    buildArticleMessages({
      query,
      cards: promptCards,
      referenceChunks,
    }),
    provider
  );

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
        const message =
          typeof (raw as Record<string, unknown>).noDataMessage === "string"
            ? ((raw as Record<string, unknown>).noDataMessage as string)
            : "В канонических карточках нет достаточных сведений по запросу.";

        return NextResponse.json(buildNoDataDraft({ query, message }));
      }

      articlePayload = normalizeGeneratedArticle(raw, {
        selectedCards,
        matchedArticles,
      });
    } catch (parseError) {
      actualProvider = "canonical";
      modelLabel = "Канонический движок (резерв после некорректного JSON модели)";
      fallbackReason =
        parseError instanceof Error
          ? parseError.message
          : "Модель вернула некорректную структуру — использована строгая сборка по карточкам.";
    }
  }

  if (!articlePayload) {
    articlePayload = buildDeterministicArticleDraft({
      query,
      selectedCards,
      matchedArticles,
      referenceChunks,
    });
  }

  const sources = articlePayload.sourceCardIds
    .map((cardId) => cards.find((card) => card.id === cardId))
    .filter((card): card is KnowledgeCard => Boolean(card))
    .map(sourceSummary);

  return NextResponse.json({
    noData: false,
    noDataMessage: null,
    query,
    article: { ...articlePayload, query },
    sources,
    usedArticles: matchedArticles.map((item) => ({
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
