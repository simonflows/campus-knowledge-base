import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  callAlibabaAi,
  getAlibabaAiConfig,
  isAlibabaAiConfigured,
  sanitizeCardFor152FZ,
} from "@/lib/alibaba-ai";
import { buildAnalyticsReport } from "@/lib/analytics";
import { flattenArticleChunks, type ReadyArticle } from "@/lib/articles";
import { FACT_CHECK_PRESETS } from "@/lib/audit-canon-registry";
import { isStorageWritable } from "@/lib/db";
import {
  buildArticleMessages,
  buildDeterministicArticleDraft,
  extractJsonObject,
  normalizeGeneratedArticle,
  selectRelevantArticles,
  selectRelevantCards,
  serializeCardForPrompt,
} from "@/lib/editor";
import { checkFactText } from "@/lib/fact-check";
import type { KnowledgeCard } from "@/lib/knowledge";
import { mockArticles, mockKnowledgeCards } from "@/lib/mock-data";
import {
  ensureArticleSeed,
  ensureKnowledgeSeed,
  getAllArticles,
  getCanonicalKnowledgeCards,
} from "@/lib/models";
import {
  callYandexAi,
  getYandexAiConfig,
  isYandexAiConfigured,
} from "@/lib/yandex-ai";

const benchmarkInputSchema = z.object({
  scenario: z
    .enum(["all", "fact-check", "article", "analytics"])
    .default("all"),
});

async function loadData(): Promise<{
  cards: KnowledgeCard[];
  articles: ReadyArticle[];
}> {
  if (await isStorageWritable()) {
    try {
      await Promise.all([ensureKnowledgeSeed(), ensureArticleSeed()]);
      const [cards, articles] = await Promise.all([
        getCanonicalKnowledgeCards(),
        getAllArticles(),
      ]);
      return { cards, articles };
    } catch (error) {
      console.error("Ошибка загрузки данных для бенчмарка:", error);
    }
  }
  return { cards: mockKnowledgeCards, articles: mockArticles };
}

export interface PlatformRunResult {
  platform: "yandex" | "alibaba";
  platformName: string;
  mode: "live" | "demo";
  model: string;
  latencyMs: number;
  fz152Status: string;
  summary: string;
  excerpt: string;
  error: string | null;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const parsed = benchmarkInputSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Некорректные параметры запуска полигона" },
      { status: 400 }
    );
  }

  const { cards, articles } = await loadData();
  const yandexCfg = getYandexAiConfig();
  const alibabaCfg = getAlibabaAiConfig();

  // 1. Fact-check scenario
  const draftToTest = FACT_CHECK_PRESETS[0].text;
  const deterministicFactCheck = checkFactText(draftToTest, cards);
  const relevantForCheck = cards.filter((c) =>
    ["campus-passport", "joint-midis-susmu-trauma", "lab-susmu-vr-biomed"].includes(c.id)
  );

  const factCheckPrompt = (promptCards: KnowledgeCard[]) => [
    {
      role: "system" as const,
      text: "Ты фактчекер кампуса «Южный Урал». Найди красные (прямое искажение) и жёлтые (неподтверждённые цифры) ошибки в тексте строго по карточкам. Ответь кратко в 3–4 пункта со ссылками на ID карточек.",
    },
    {
      role: "user" as const,
      text: `Черновик: ${draftToTest}\n\nКарточки:\n${promptCards.map(serializeCardForPrompt).join("\n---\n")}`,
    },
  ];

  const runFactCheckPlatform = async (
    platform: "yandex" | "alibaba"
  ): Promise<PlatformRunResult> => {
    const start = Date.now();
    const isYandex = platform === "yandex";
    const configured = isYandex
      ? isYandexAiConfigured()
      : isAlibabaAiConfigured();
    const scopedCards = isYandex
      ? relevantForCheck
      : relevantForCheck.map(sanitizeCardFor152FZ);

    if (!configured) {
      return {
        platform,
        platformName: isYandex
          ? "Yandex AI Studio"
          : "Alibaba Cloud Model Studio",
        mode: "demo",
        model: isYandex ? yandexCfg.modelUri : alibabaCfg.modelName,
        latencyMs: isYandex ? 820 : 940,
        fz152Status: isYandex
          ? "РФ контур (152-ФЗ соблюдён)"
          : "ПДн обезличены перед отправкой",
        summary: `Выявлено нарушений: ${deterministicFactCheck.summary.red} красных, ${deterministicFactCheck.summary.yellow} жёлтых (по каноническому эталону)`,
        excerpt: deterministicFactCheck.findings
          .filter((f) => f.level !== "green")
          .slice(0, 3)
          .map((f) => `• [${f.level.toUpperCase()}] ${f.title} (${f.sourceCardId})`)
          .join("\n"),
        error: null,
      };
    }

    try {
      const responseText = isYandex
        ? await callYandexAi(factCheckPrompt(scopedCards), {
            temperature: 0.05,
            maxTokens: 1200,
          })
        : await callAlibabaAi(factCheckPrompt(scopedCards), {
            temperature: 0.05,
            maxTokens: 1200,
          });
      return {
        platform,
        platformName: isYandex
          ? "Yandex AI Studio"
          : "Alibaba Cloud Model Studio",
        mode: "live",
        model: isYandex ? yandexCfg.modelUri : alibabaCfg.modelName,
        latencyMs: Date.now() - start,
        fz152Status: isYandex
          ? "РФ контур (152-ФЗ соблюдён)"
          : "ПДн обезличены фильтром 152-ФЗ",
        summary: `Живой ответ модели + сверка с эталоном (${deterministicFactCheck.summary.red} красных, ${deterministicFactCheck.summary.yellow} жёлтых)`,
        excerpt: responseText.slice(0, 650),
        error: null,
      };
    } catch (err) {
      return {
        platform,
        platformName: isYandex
          ? "Yandex AI Studio"
          : "Alibaba Cloud Model Studio",
        mode: "demo",
        model: isYandex ? yandexCfg.modelUri : alibabaCfg.modelName,
        latencyMs: Date.now() - start,
        fz152Status: isYandex ? "РФ контур" : "Обезличено 152-ФЗ",
        summary: `Ошибка API (показан эталон): ${deterministicFactCheck.summary.red} красных`,
        excerpt: deterministicFactCheck.findings
          .slice(0, 2)
          .map((f) => `• ${f.title}`)
          .join("\n"),
        error: err instanceof Error ? err.message : "Ошибка запроса к API",
      };
    }
  };

  // 2. Article generation scenario
  const articleQuery =
    "Напиши статью о сотрудничестве МИДиС и ЮУГМУ по виртуальному травмпункту с опорой на уже вышедший материал ЮУГМУ";
  const selectedCards = selectRelevantCards(cards, articleQuery).map(
    (item) => item.card
  );
  const matchedArticles = selectRelevantArticles(articles, articleQuery);
  const referenceChunks = matchedArticles
    .flatMap((article) => flattenArticleChunks(article))
    .slice(0, 6);
  const deterministicDraft = buildDeterministicArticleDraft({
    query: articleQuery,
    selectedCards,
    matchedArticles,
    referenceChunks,
  });

  const runArticlePlatform = async (
    platform: "yandex" | "alibaba"
  ): Promise<PlatformRunResult> => {
    const start = Date.now();
    const isYandex = platform === "yandex";
    const configured = isYandex
      ? isYandexAiConfigured()
      : isAlibabaAiConfigured();
    const scopedCards = isYandex
      ? selectedCards
      : selectedCards.map(sanitizeCardFor152FZ);

    if (!configured) {
      return {
        platform,
        platformName: isYandex
          ? "Yandex AI Studio"
          : "Alibaba Cloud Model Studio",
        mode: "demo",
        model: isYandex ? yandexCfg.modelUri : alibabaCfg.modelName,
        latencyMs: isYandex ? 1650 : 1420,
        fz152Status: isYandex
          ? "РФ контур (152-ФЗ)"
          : "ПДн обезличены (152-ФЗ)",
        summary: `H1 + лид (${deterministicDraft.lead.length} зн.) + ${deterministicDraft.sections.length} чанков по SEO/GEO`,
        excerpt: `${deterministicDraft.title}\n\n${deterministicDraft.lead}`,
        error: null,
      };
    }

    try {
      const messages = buildArticleMessages({
        query: articleQuery,
        cards: scopedCards,
        referenceChunks,
      });
      const text = isYandex
        ? await callYandexAi(messages, { temperature: 0.05 })
        : await callAlibabaAi(messages, { temperature: 0.05 });
      const parsedJson = normalizeGeneratedArticle(extractJsonObject(text), {
        selectedCards,
        matchedArticles,
      });
      return {
        platform,
        platformName: isYandex
          ? "Yandex AI Studio"
          : "Alibaba Cloud Model Studio",
        mode: "live",
        model: isYandex ? yandexCfg.modelUri : alibabaCfg.modelName,
        latencyMs: Date.now() - start,
        fz152Status: isYandex
          ? "РФ контур (152-ФЗ)"
          : "ПДн обезличены (152-ФЗ)",
        summary: `Живая генерация: лид ${parsedJson.lead.length} зн., разделов H2/H3: ${parsedJson.sections.length}`,
        excerpt: `${parsedJson.title}\n\n${parsedJson.lead}`,
        error: null,
      };
    } catch (err) {
      return {
        platform,
        platformName: isYandex
          ? "Yandex AI Studio"
          : "Alibaba Cloud Model Studio",
        mode: "demo",
        model: isYandex ? yandexCfg.modelUri : alibabaCfg.modelName,
        latencyMs: Date.now() - start,
        fz152Status: isYandex ? "РФ контур" : "ПДн обезличены",
        summary: "Ошибка live-вызова — показан канонический расчёт",
        excerpt: `${deterministicDraft.title}\n\n${deterministicDraft.lead}`,
        error: err instanceof Error ? err.message : "Ошибка генерации",
      };
    }
  };

  // 3. Analytics scenario
  const analyticsQuery =
    "Собери все проекты взаимодействия вузов с индустриальными партнёрами в сфере медицины";
  const analyticsReport = buildAnalyticsReport(analyticsQuery, cards);

  const runAnalyticsPlatform = async (
    platform: "yandex" | "alibaba"
  ): Promise<PlatformRunResult> => {
    const start = Date.now();
    const isYandex = platform === "yandex";
    const configured = isYandex
      ? isYandexAiConfigured()
      : isAlibabaAiConfigured();

    const baseExcerpt = analyticsReport.cards
      .map(
        (row) =>
          `• ${row.title} (${row.universities.join(", ")}) — партнёр: ${row.partner}, статус: ${row.status}`
      )
      .join("\n");

    if (!configured) {
      return {
        platform,
        platformName: isYandex
          ? "Yandex AI Studio"
          : "Alibaba Cloud Model Studio",
        mode: "demo",
        model: isYandex ? yandexCfg.modelUri : alibabaCfg.modelName,
        latencyMs: isYandex ? 540 : 610,
        fz152Status: isYandex
          ? "РФ контур (152-ФЗ)"
          : "Открытые поля без ПДн",
        summary: `Найдено карточек: ${analyticsReport.summary.total} (совместных: ${analyticsReport.summary.jointProjects})`,
        excerpt: baseExcerpt,
        error: null,
      };
    }

    try {
      const messages = [
        {
          role: "system" as const,
          text: "Сформируй краткую аналитическую сводку (3 предложения) строго по предоставленной выборке базы знаний. Ничего не выдумывай.",
        },
        {
          role: "user" as const,
          text: `Запрос: ${analyticsQuery}\n\nВыборка из базы:\n${baseExcerpt}`,
        },
      ];
      const text = isYandex
        ? await callYandexAi(messages, { temperature: 0.05, maxTokens: 700 })
        : await callAlibabaAi(messages, { temperature: 0.05, maxTokens: 700 });
      return {
        platform,
        platformName: isYandex
          ? "Yandex AI Studio"
          : "Alibaba Cloud Model Studio",
        mode: "live",
        model: isYandex ? yandexCfg.modelUri : alibabaCfg.modelName,
        latencyMs: Date.now() - start,
        fz152Status: isYandex
          ? "РФ контур (152-ФЗ)"
          : "Открытые поля без ПДн",
        summary: `Live-резюме по ${analyticsReport.summary.total} карточкам базы`,
        excerpt: text,
        error: null,
      };
    } catch (err) {
      return {
        platform,
        platformName: isYandex
          ? "Yandex AI Studio"
          : "Alibaba Cloud Model Studio",
        mode: "demo",
        model: isYandex ? yandexCfg.modelUri : alibabaCfg.modelName,
        latencyMs: Date.now() - start,
        fz152Status: isYandex ? "РФ контур" : "Открытые поля без ПДн",
        summary: `Детерминированная выборка: ${analyticsReport.summary.total} карточек`,
        excerpt: baseExcerpt,
        error: err instanceof Error ? err.message : "Ошибка аналитики",
      };
    }
  };

  const targetScenario = parsed.data.scenario;

  const [
    fcYandex,
    fcAlibaba,
    artYandex,
    artAlibaba,
    anYandex,
    anAlibaba,
  ] = await Promise.all([
    targetScenario === "all" || targetScenario === "fact-check"
      ? runFactCheckPlatform("yandex")
      : Promise.resolve(null),
    targetScenario === "all" || targetScenario === "fact-check"
      ? runFactCheckPlatform("alibaba")
      : Promise.resolve(null),
    targetScenario === "all" || targetScenario === "article"
      ? runArticlePlatform("yandex")
      : Promise.resolve(null),
    targetScenario === "all" || targetScenario === "article"
      ? runArticlePlatform("alibaba")
      : Promise.resolve(null),
    targetScenario === "all" || targetScenario === "analytics"
      ? runAnalyticsPlatform("yandex")
      : Promise.resolve(null),
    targetScenario === "all" || targetScenario === "analytics"
      ? runAnalyticsPlatform("alibaba")
      : Promise.resolve(null),
  ]);

  const sampleCard =
    cards.find((c) => c.id === "joint-midis-susmu-trauma") ?? cards[0];
  const sampleSanitized = sampleCard ? sanitizeCardFor152FZ(sampleCard) : null;

  const allScenarios = [
    fcYandex && fcAlibaba
      ? {
          id: "fact-check",
          title: "Сценарий 1. Фактчекинг черновика с ошибками (ТЗ + Аудит)",
          input: draftToTest,
          yandex: fcYandex,
          alibaba: fcAlibaba,
        }
      : null,
    artYandex && artAlibaba
      ? {
          id: "article",
          title: "Сценарий 2. Генерация SEO/GEO-статьи чанками (МИДиС + ЮУГМУ)",
          input: articleQuery,
          yandex: artYandex,
          alibaba: artAlibaba,
        }
      : null,
    anYandex && anAlibaba
      ? {
          id: "analytics",
          title: "Сценарий 3. Сборная аналитика по отрасли (Медицина)",
          input: analyticsQuery,
          yandex: anYandex,
          alibaba: anAlibaba,
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  return NextResponse.json({
    executedAt: new Date().toISOString(),
    livePlatforms: {
      yandex: isYandexAiConfigured(),
      alibaba: isAlibabaAiConfigured(),
    },
    scenarios: allScenarios,
    fz152Preview: sampleCard && sampleSanitized
      ? {
          cardId: sampleCard.id,
          originalOwners: sampleCard.owners,
          anonymizedOwners: sampleSanitized.owners,
        }
      : null,
  });
}
