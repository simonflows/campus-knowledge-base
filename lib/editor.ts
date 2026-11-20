import {
  flattenArticleChunks,
  type FlatArticleChunk,
  type GeneratedArticleDraft,
  type ReadyArticle,
} from "./articles";
import { universities } from "./data";
import { checkFactText } from "./fact-check";
import {
  getApprovedVersion,
  getFolderPathLabel,
  getUniversityFullName,
  getUniversityName,
  isJointProject,
  placementStatusLabels,
  type KnowledgeCard,
  type StructuredMetric,
  type UniversityCard,
} from "./knowledge";
import type { YandexAiMessage } from "./yandex-ai";
import {
  generatedArticleSchema,
  type GeneratedArticlePayload,
} from "./validation/articles";

const stopWords = new Set([
  "напиши",
  "написать",
  "сделай",
  "сделать",
  "статья",
  "статью",
  "статьи",
  "статей",
  "материал",
  "материала",
  "материалы",
  "опорой",
  "основе",
  "основа",
  "нужно",
  "нужен",
  "нужна",
  "про",
  "для",
  "чтобы",
  "это",
  "как",
  "что",
  "кто",
  "где",
  "или",
  "при",
  "уже",
  "вышедший",
  "вышедшую",
  "вышедшего",
  "сотрудничестве",
  "сотрудничество",
  "сотрудничества",
  "вуз",
  "вуза",
  "вузов",
  "вузе",
  "университет",
  "университета",
  "университете",
  "на",
  "по",
  "из",
  "от",
  "до",
  "за",
  "об",
  "не",
  "но",
  "да",
  "то",
  "же",
  "ли",
  "бы",
  "во",
  "со",
  "ко",
  "под",
  "над",
  "без",
  "том",
  "все",
  "всё",
  "очень",
  "устроен",
]);

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim();
}

function tokenRoot(token: string): string {
  if (token.length <= 4) return token;
  return token.slice(0, 5);
}

function queryTokens(query: string): string[] {
  return normalize(query)
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !stopWords.has(token))
    .map(tokenRoot);
}

function matchesRoot(haystack: string, root: string): boolean {
  return haystack.includes(root);
}

function cardSearchText(card: KnowledgeCard): string {
  const parts: string[] = [
    card.title,
    card.referenceDescription,
    card.stopFormula,
    card.owners.join(" "),
    getFolderPathLabel(card.folderId),
    getUniversityName(
      card.type === "project" ? card.initiatorUniversityId : ""
    ),
  ];

  if (card.type === "university") {
    parts.push(
      getUniversityName(card.universityId),
      getUniversityFullName(card.universityId),
      ...(card.structuredMetrics ?? []).map(
        (metric) =>
          `${metric.label} ${metric.value} ${metric.unit} ${metric.year}`
      )
    );
  }

  if (card.type === "project") {
    parts.push(
      card.sphere,
      card.industrialPartner,
      card.coExecutors.join(" "),
      card.confirmedFigures.join(" "),
      card.readinessStage,
      card.contour,
      card.participantUniversityIds
        .map((universityId) => getUniversityName(universityId))
        .join(" ")
    );
  }

  if (card.type === "laboratory") {
    parts.push(
      card.affiliation,
      card.partner,
      card.head,
      card.placementDetails,
      placementStatusLabels[card.placementStatus],
      card.workDirections.join(" "),
      card.equipment.join(" "),
      card.confirmedIndicators.join(" ")
    );
  }

  if (card.type === "campus") {
    parts.push(
      card.campusMetrics
        .map((metric) => `${metric.label} ${metric.value} ${metric.note}`)
        .join(" "),
      card.tariffs.map((tariff) => `${tariff.label} ${tariff.value}`).join(" "),
      card.legalEntities
        .map((entity) => `${entity.name} ${entity.role}`)
        .join(" "),
      card.stopList.join(" ")
    );
  }

  const customFields = (
    card as {
      customFields?: Record<string, string | number | string[] | null>;
    }
  ).customFields;

  if (customFields) {
    parts.push(
      Object.values(customFields)
        .flat()
        .map((value) => (value == null ? "" : String(value)))
        .join(" ")
    );
  }

  return normalize(parts.filter(Boolean).join(" "));
}

export type ScoredCard = {
  card: KnowledgeCard;
  score: number;
};

export function selectRelevantCards(
  cards: KnowledgeCard[],
  query: string,
  limit = 6
): ScoredCard[] {
  const roots = queryTokens(query);

  if (roots.length === 0) return [];

  return cards
    .map(getApprovedVersion)
    .filter((card): card is KnowledgeCard => card !== null)
    .map((card) => {
      const text = cardSearchText(card);
      const title = normalize(card.title);
      const uniqueRoots = new Set(roots);
      let score = 0;
      let matchedRoots = 0;
      let titleMatched = false;

      uniqueRoots.forEach((root) => {
        const inText = matchesRoot(text, root);
        const inTitle = matchesRoot(title, root);

        if (inText || inTitle) matchedRoots += 1;
        if (inText) score += 5;
        if (inTitle) {
          score += 3;
          titleMatched = true;
        }
      });

      return { card, score, matchedRoots, titleMatched };
    })
    .filter((item) => {
      const enoughMatches =
        item.matchedRoots >= 2 ||
        (item.titleMatched && new Set(roots).size === 1);

      return item.score >= 8 && enoughMatches;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => ({ card: item.card, score: item.score }));
}

export function selectRelevantArticles(
  articles: ReadyArticle[],
  query: string,
  limit = 4
): ReadyArticle[] {
  const roots = queryTokens(query);

  if (roots.length === 0) return [];

  return articles
    .map((article) => {
      const text = normalize(
        [
          article.title,
          article.lead,
          article.projectTitle,
          article.topic,
          ...flattenArticleChunks(article).map((chunk) => chunk.content),
        ].join(" ")
      );
      const title = normalize(article.title);
      let score = 0;

      new Set(roots).forEach((root) => {
        if (matchesRoot(text, root)) score += 2;
        if (matchesRoot(title, root)) score += 2;
      });

      return { article, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.article);
}

export function getBasisChunks(
  article: ReadyArticle | undefined,
  chunkIds: string[] | undefined
): FlatArticleChunk[] {
  if (!article || !chunkIds || chunkIds.length === 0) return [];

  const wanted = new Set(chunkIds);
  return flattenArticleChunks(article).filter((chunk) =>
    wanted.has(chunk.chunkId)
  );
}

function cardUniversityLabel(card: KnowledgeCard): string {
  if (card.type === "university")
    return getUniversityFullName(card.universityId);

  if (card.type === "project") {
    const initiator = getUniversityName(card.initiatorUniversityId);
    if (isJointProject(card)) {
      return `${initiator} (совместный проект: ${card.participantUniversityIds
        .map((universityId) => getUniversityName(universityId))
        .join(", ")})`;
    }
    return initiator;
  }

  if (card.type === "laboratory") {
    return card.affiliation;
  }

  return "Кампус «Южный Урал»";
}

export function serializeCardForPrompt(card: KnowledgeCard): string {
  const lines = [
    `ID карточки: ${card.id}`,
    `Тип: ${card.type}`,
    `Название: ${card.title}`,
    `Папка: ${getFolderPathLabel(card.folderId)}`,
    `Вуз / принадлежность: ${cardUniversityLabel(card)}`,
    `Эталонное описание: ${card.referenceDescription}`,
    `Стоп-формула: ${card.stopFormula}`,
  ];

  if (card.type === "project") {
    lines.push(
      `Сфера: ${card.sphere}`,
      `Вуз-инициатор: ${getUniversityName(card.initiatorUniversityId)}`,
      `Соисполнители: ${card.coExecutors.join(", ") || "нет"}`,
      `Индустриальный партнёр: ${card.industrialPartner}`,
      `Стадия готовности: ${card.readinessStage}`,
      `Контур: ${card.contour}`,
      `Подтверждённые цифры и факты: ${card.confirmedFigures.join("; ")}`
    );
  }

  if (card.type === "laboratory") {
    lines.push(
      `Принадлежность: ${card.affiliation}`,
      `Партнёр: ${card.partner}`,
      `Статус размещения: ${placementStatusLabels[card.placementStatus]}`,
      `Детали размещения: ${card.placementDetails}`,
      `Направления: ${card.workDirections.join("; ")}`,
      `Оборудование: ${card.equipment.join("; ")}`,
      `Подтверждённые показатели: ${card.confirmedIndicators.join("; ")}`
    );
  }

  if (card.type === "campus") {
    lines.push(
      `Параметры: ${card.campusMetrics
        .map((metric) => `${metric.label} — ${metric.value} (${metric.note})`)
        .join("; ")}`,
      `Тарифы: ${card.tariffs
        .map((tariff) => `${tariff.label} — ${tariff.value}`)
        .join("; ")}`,
      `Юрлица: ${card.legalEntities
        .map((entity) => `${entity.name} — ${entity.role}`)
        .join("; ")}`,
      `Стоп-лист: ${card.stopList.join("; ")}`
    );
  }

  if (card.type === "university") {
    lines.push("Показатели вуза с подтверждением из документа:");
    lines.push(
      ...(card.structuredMetrics ?? []).map(
        (metric) =>
          `${formatUniversityMetric(card, metric)} Документ: ${metric.evidenceUrl}`
      )
    );
  }

  return lines.join("\n");
}

export function serializeApprovedChunk(chunk: FlatArticleChunk): string {
  return [
    `Статья: ${chunk.articleTitle}`,
    `Смысловой блок: ${chunk.sectionHeading}`,
    `Живая формулировка: ${chunk.content}`,
  ].join("\n");
}

const systemPrompt = `Ты — редактор пресс-службы кампуса «Южный Урал» и семи вузов-резидентов. Ты пишешь только по предоставленным официальным данным и утверждённым статьям коллег.

Жёсткие правила:
1. Не используй общие знания модели и не добавляй факты, цифры, имена или сроки, которых нет в карточках.
2. Если для запроса не хватает данных, не придумывай текст: верни noData=true и короткое честное сообщение в noDataMessage.
3. Заголовок H1 — title. Подзаголовки только H2 или H3 — sections[].heading и sections[].level.
4. Первые 1000 знаков (поле lead и первый chunk) должны ясно раскрывать: кто с кем сотрудничает, что создано, в каком контуре, в чём практическая польза.
5. Пиши живым языком без канцелярита. Избегай штампов «в рамках», «в целях», «осуществляется».
6. Дели текст на самодостаточные чанки по 1–2 абзаца. В каждом чанке явно называй участников, проект и факты, чтобы блок можно было понять отдельно от статьи.
7. Не приписывай совместный проект одному вузу или партнёру. Не меняй статус лаборатории и контур проекта.
8. После каждого утверждения с датой, числом или статусом укажи ID подтверждающей карточки в квадратных скобках. Перечисли эти же ID в sourceCardIds. Показатель вуза указывай с названием вуза, единицей, годом и отметкой факт/план.

Верни строго JSON без markdown и без пояснений:
{
  "noData": false,
  "noDataMessage": null,
  "title": "заголовок H1",
  "lead": "сильные первые 1000 знаков",
  "sections": [
    {
      "heading": "подзаголовок H2 или H3",
      "level": 2,
      "chunks": ["самодостаточный чанк из 1–2 абзацев", "ещё один чанк"]
    }
  ],
  "sourceCardIds": ["id карточки"],
  "projectTitle": "название проекта или темы",
  "topic": "короткая тема для фильтра",
  "suggestedUniversityId": "id вуза или null"
}`;

export function buildArticleMessages(params: {
  query: string;
  cards: KnowledgeCard[];
  referenceChunks: FlatArticleChunk[];
}): YandexAiMessage[] {
  const cardsText = params.cards
    .map(serializeCardForPrompt)
    .join("\n\n---\n\n");

  const referenceText =
    params.referenceChunks.length > 0
      ? params.referenceChunks.map(serializeApprovedChunk).join("\n\n---\n\n")
      : "Утверждённых статей-опор по этому запросу нет.";

  return [
    { role: "system", text: systemPrompt },
    {
      role: "user",
      text: [
        `Запрос специалиста: ${params.query}`,
        "",
        "Доступные канонические карточки (единственный источник твёрдых фактов и цифр):",
        cardsText,
        "",
        "Живые формулировки из утверждённых статей коллег (можно брать тон и удачные формулировки, но нельзя брать оттуда неподтверждённые факты):",
        referenceText,
        "",
        "Собери статью по правилам выше. В sourceCardIds укажи только ID реально использованных карточек из списка.",
      ].join("\n"),
    },
  ];
}

export function extractJsonObject(text: string): unknown {
  const withoutFences = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Модель не вернула JSON-объект статьи");
  }

  return JSON.parse(withoutFences.slice(start, end + 1));
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toSectionLevel(value: unknown): 2 | 3 {
  return value === 3 || value === "3" || value === "H3" ? 3 : 2;
}

function toChunks(value: unknown): Array<{ id: string; content: string }> {
  if (!Array.isArray(value)) return [];

  return value
    .map((item, index) => {
      if (typeof item === "string") {
        return { id: `chunk-${index + 1}`, content: item.trim() };
      }

      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        return {
          id: asString(record.id) || `chunk-${index + 1}`,
          content: asString(record.content) || asString(record.text),
        };
      }

      return { id: `chunk-${index + 1}`, content: "" };
    })
    .filter((chunk) => chunk.content.length > 0);
}

function findUniversityIdForCard(card: KnowledgeCard): string | null {
  if (card.type === "university") return card.universityId;

  if (card.type === "project") {
    if (card.isJoint) {
      return card.participantUniversityIds[0] ?? null;
    }
    return card.initiatorUniversityId;
  }

  if (card.type === "laboratory") {
    const normalizedAffiliation = normalize(card.affiliation);
    const match = universities.find(
      (university) =>
        normalize(university.shortName) === normalizedAffiliation ||
        normalize(university.fullName) === normalizedAffiliation
    );
    return match?.id ?? null;
  }

  return null;
}

function fallbackTopic(card: KnowledgeCard): string {
  if (card.type === "project") return card.sphere;
  if (card.type === "laboratory")
    return card.workDirections[0] ?? "Лаборатория";
  if (card.type === "campus") return "Кампус «Южный Урал»";
  if (card.type === "university")
    return `Показатели ${getUniversityName(card.universityId)}`;
  return "Материалы базы знаний";
}

export function normalizeGeneratedArticle(
  raw: unknown,
  params: {
    selectedCards: KnowledgeCard[];
    matchedArticles: ReadyArticle[];
  }
): GeneratedArticlePayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("Модель вернула некорректный ответ");
  }

  const record = raw as Record<string, unknown>;
  const allowedIds = new Set(params.selectedCards.map((card) => card.id));
  const rawSourceIds = Array.isArray(record.sourceCardIds)
    ? record.sourceCardIds.map(asString).filter(Boolean)
    : [];
  if (!rawSourceIds.length || rawSourceIds.some((id) => !allowedIds.has(id))) {
    throw new Error("Модель не указала проверяемые карточки-источники");
  }
  const finalSourceIds = [...new Set(rawSourceIds)];

  const sourceCardTitles = finalSourceIds
    .map(
      (id) => params.selectedCards.find((card) => card.id === id)?.title ?? ""
    )
    .filter(Boolean);

  const rawSections = Array.isArray(record.sections) ? record.sections : [];
  const sections = rawSections
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const section = item as Record<string, unknown>;
      const heading = asString(section.heading);
      const chunks = toChunks(section.chunks);

      if (!heading || chunks.length === 0) return null;

      return {
        id: asString(section.id) || `section-${index + 1}`,
        heading,
        level: toSectionLevel(section.level),
        chunks: chunks.map((chunk, chunkIndex) => ({
          ...chunk,
          id: `${asString(section.id) || `section-${index + 1}`}-chunk-${chunkIndex + 1}`,
        })),
      };
    })
    .filter((section): section is NonNullable<typeof section> =>
      Boolean(section)
    );

  const firstCard = params.selectedCards[0];
  const suggestedUniversityId =
    asString(record.suggestedUniversityId) ||
    (firstCard ? findUniversityIdForCard(firstCard) : "");

  const projectTitle =
    asString(record.projectTitle) || firstCard?.title || "Официальные данные";
  const topic =
    asString(record.topic) ||
    (firstCard ? fallbackTopic(firstCard) : "Материалы базы знаний");

  return generatedArticleSchema.parse({
    noData: record.noData === true,
    noDataMessage:
      record.noData === true
        ? asString(record.noDataMessage) ||
          "В официальных данных нет достаточных сведений по запросу."
        : null,
    title: asString(record.title),
    lead: asString(record.lead),
    sections,
    sourceCardIds: finalSourceIds,
    sourceCardTitles,
    projectTitle,
    topic,
    suggestedUniversityId: suggestedUniversityId || null,
    usedArticleIds: params.matchedArticles.map((article) => article.id),
  });
}

export function buildNoDataDraft(params: {
  query: string;
  message: string;
}): GeneratedArticleDraft {
  return {
    noData: true,
    noDataMessage: params.message,
    title: "",
    lead: "",
    sections: [],
    sourceCardIds: [],
    sourceCardTitles: [],
    projectTitle: "",
    topic: "",
    suggestedUniversityId: null,
    usedArticleIds: [],
    query: params.query,
  };
}

const metricUnitKeywords = [
  "мест",
  "студент",
  "обучающ",
  "преподавател",
  "аспирант",
  "сотрудник",
  "процент",
];

export function selectUniversityMetricCards(
  query: string,
  cards: KnowledgeCard[]
): UniversityCard[] | null {
  const normalized = normalize(query);
  const universitiesInQuery = universities.filter((university) => {
    const shortName = normalize(university.shortName);
    return (
      ` ${normalized} `.includes(` ${shortName} `) ||
      normalized.includes(normalize(university.fullName))
    );
  });
  const hasExplicitUniversity = universitiesInQuery.length > 0;
  const asksForPassport = /паспорт[а-я]*\s+(?:вуза|университета)/u.test(
    normalized
  );
  const requestedUnits = metricUnitKeywords.filter((keyword) =>
    normalized.split(" ").some((word) => word.startsWith(keyword))
  );
  const asksForMetrics =
    /квот|численност|показател/u.test(normalized) ||
    (requestedUnits.length > 0 &&
      /сколько|количеств|число|статистик/u.test(normalized));
  if (!asksForPassport && !(hasExplicitUniversity && asksForMetrics))
    return null;

  const years = new Set(
    Array.from(normalized.matchAll(/\b(?:19|20|21)\d{2}\b/g), (match) =>
      Number(match[0])
    )
  );
  const wantsQuota = /квот/u.test(normalized);
  const wantsPlan = /план|запланирован|будет|будут/u.test(normalized);
  const wantsActual =
    /фактическ|по факту/u.test(normalized) ||
    normalized.split(" ").includes("факт");
  const explicitMetric = query.match(
    /показател[а-я]*\s+[«"]([^"»]+)["»]/iu
  )?.[1];
  const wantedIds = new Set(
    universitiesInQuery.map((university) => university.id)
  );

  return cards
    .map(getApprovedVersion)
    .filter(
      (card): card is UniversityCard =>
        card?.type === "university" &&
        (!hasExplicitUniversity || wantedIds.has(card.universityId))
    )
    .map((card) => ({
      ...card,
      structuredMetrics: (card.structuredMetrics ?? []).filter((metric) => {
        const label = normalize(metric.label);
        const unit = normalize(metric.unit);
        return (
          (years.size === 0 || years.has(metric.year)) &&
          (!wantsPlan || wantsActual || metric.kind === "plan") &&
          (!wantsActual || wantsPlan || metric.kind === "actual") &&
          (!wantsQuota || label.includes("квот")) &&
          (!explicitMetric || label === normalize(explicitMetric)) &&
          (requestedUnits.length === 0 ||
            requestedUnits.some(
              (keyword) =>
                unit.startsWith(keyword) ||
                label.split(" ").some((word) => word.startsWith(keyword))
            ))
        );
      }),
    }));
}

function formatUniversityMetric(
  card: UniversityCard,
  metric: StructuredMetric
): string {
  const status = metric.kind === "plan" ? "план" : "факт";
  const value = new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 12,
  }).format(metric.value);
  return `${getUniversityName(card.universityId)} за ${metric.year} год (${status}) — ${metric.label.toLowerCase()} составляет ${value} ${metric.unit}. [${card.id}]`;
}

const numeral =
  /(?<![\p{L}\p{N}-])[-−+]?\d+(?:[   ]\d{3})*(?:[.,]\d+)?(?![\p{L}\p{N}])/gu;

function numericClaims(text: string): string[] {
  return (text.replace(/https?:\/\/[^\s)\]]+/gi, "").match(numeral) ?? []).map(
    (value) =>
      String(
        Number(value.replace(/[   ]/g, "").replace(",", ".").replace("−", "-"))
      )
  );
}

export function isGroundedArticleText(
  text: string,
  cards: KnowledgeCard[]
): boolean {
  const evidence = cards
    .filter((card) => card.type !== "custom")
    .map((card) => {
      const base = `${card.title}
${card.referenceDescription}`;
      if (card.type === "campus")
        return [
          base,
          ...card.campusMetrics.map(
            (metric) => `${metric.value} ${metric.note}`
          ),
          ...card.tariffs.map((tariff) => tariff.value),
        ].join("\n");
      if (card.type === "project")
        return [base, ...card.confirmedFigures].join("\n");
      if (card.type === "laboratory")
        return [
          base,
          card.placementDetails,
          ...card.equipment,
          ...card.confirmedIndicators,
        ].join("\n");
      return [
        base,
        ...(card.structuredMetrics ?? []).map(
          (metric) => `${metric.year}
${metric.value}`
        ),
      ].join("\n");
    })
    .join("\n");
  const allowed = new Set(numericClaims(evidence));
  if (numericClaims(text).some((value) => !allowed.has(value))) return false;
  return !checkFactText(text, cards).findings.some(
    (finding) => finding.level === "red" || finding.level === "yellow"
  );
}

export function groundGeneratedArticle(
  candidate: GeneratedArticlePayload,
  selectedCards: KnowledgeCard[]
): string | null {
  const ids = new Set(candidate.sourceCardIds);
  const sources = selectedCards.filter((card) => ids.has(card.id));
  const text = [
    candidate.title,
    candidate.lead,
    ...candidate.sections.flatMap((section) => [
      section.heading,
      ...section.chunks.map((chunk) => chunk.content),
    ]),
  ].join("\n");
  if (!isGroundedArticleText(text, sources))
    return "Ответ модели содержит противоречие или факт без подтверждения. Черновик собран по утверждённым карточкам.";
  if (candidate.lead.length > 1000)
    return "Лид модели превышает 1000 знаков. Использован черновик по утверждённым карточкам.";
  return null;
}

export function buildDeterministicArticleDraft(params: {
  query: string;
  selectedCards: KnowledgeCard[];
  matchedArticles: ReadyArticle[];
  referenceChunks: FlatArticleChunk[];
}): GeneratedArticlePayload {
  const primary = params.selectedCards[0];

  if (!primary) {
    throw new Error("Нет карточек официальных данных для сборки статьи");
  }

  const secondaryCards = params.selectedCards.slice(1, 3);
  const sections: GeneratedArticlePayload["sections"] = [];

  let title = primary.title;
  let lead = primary.referenceDescription;

  if (primary.type === "project") {
    const initiator = getUniversityName(primary.initiatorUniversityId);
    const participants = primary.isJoint
      ? primary.participantUniversityIds.map(getUniversityName).join(" и ")
      : [initiator, ...primary.coExecutors].filter(Boolean).join(" и ");

    title = primary.isJoint
      ? `${primary.title}: совместная разработка ${participants} в кампусе «Южный Урал»`
      : `${primary.title} — проект ${participants} в контуре «${primary.contour}»`;

    lead = [
      primary.referenceDescription,
      `Контур реализации — «${primary.contour}», текущая стадия готовности — «${primary.readinessStage}».`,
      primary.confirmedFigures.length > 0
        ? `Ключевые подтверждённые факты: ${primary.confirmedFigures.join("; ")}.`
        : "",
    ]
      .filter(Boolean)
      .join(" ")
      .slice(0, 990);

    sections.push({
      id: "section-participants",
      heading: `Участники и роли: ${participants}`,
      level: 2,
      chunks: [
        {
          id: "section-participants-chunk-1",
          content: primary.isJoint
            ? `Проект «${primary.title}» является совместной разработкой ${participants} в контуре кампуса «Южный Урал». Вуз-инициатор — ${initiator}, соисполнители — ${primary.coExecutors.join(", ") || "участники консорциума"}, индустриальный партнёр — ${primary.industrialPartner}.`
            : `Инициатор разработки «${primary.title}» — ${initiator}${primary.coExecutors.length > 0 ? `, соисполнители — ${primary.coExecutors.join(", ")}` : ""}. Индустриальным партнёром выступает ${primary.industrialPartner}.`,
        },
      ],
    });

    sections.push({
      id: "section-results",
      heading: `Практическая польза и подтверждённые результаты (${primary.sphere})`,
      level: 2,
      chunks: [
        {
          id: "section-results-chunk-1",
          content: `В рамках направления «${primary.sphere}» команда ${participants} развивает решение «${primary.title}» на стадии «${primary.readinessStage}». ${
            primary.confirmedFigures.length > 0
              ? `Документально подтверждены показатели: ${primary.confirmedFigures.join("; ")}.`
              : "Количественные метрики добавляются только после документального подтверждения."
          }`,
        },
      ],
    });
  } else if (primary.type === "laboratory") {
    title = `${primary.title} (${primary.affiliation}): статус, оборудование и задачи`;
    lead =
      `${primary.referenceDescription} Актуальный статус площадки: ${placementStatusLabels[primary.placementStatus].toLowerCase()} — ${primary.placementDetails}. Партнёр направления — ${primary.partner}.`.slice(
        0,
        990
      );

    sections.push({
      id: "section-lab-status",
      heading: `Статус размещения и инфраструктура (${primary.affiliation})`,
      level: 2,
      chunks: [
        {
          id: "section-lab-status-chunk-1",
          content: `${primary.title} относится к университету ${primary.affiliation} и развивается при участии партнёра ${primary.partner}. Текущий статус размещения: ${primary.placementDetails}.`,
        },
        {
          id: "section-lab-status-chunk-2",
          content: `Основные направления работ: ${primary.workDirections.join("; ")}. Оборудование, указанное в официальных данных: ${primary.equipment.join("; ")}.`,
        },
      ],
    });

    if (primary.confirmedIndicators.length > 0) {
      sections.push({
        id: "section-lab-indicators",
        heading: "Подтверждённые показатели лаборатории",
        level: 3,
        chunks: [
          {
            id: "section-lab-indicators-chunk-1",
            content: `По паспорту объекта «${primary.title}» зафиксированы показатели: ${primary.confirmedIndicators.join("; ")}.`,
          },
        ],
      });
    }
  } else if (primary.type === "campus") {
    title =
      "Кампус «Южный Урал» в Челябинске: официальные параметры, этапы ввода и 7 вузов-резидентов";
    lead = primary.referenceDescription.slice(0, 990);

    sections.push({
      id: "section-campus-metrics",
      heading: "Площади, инвестиции, вместимость и этапы ввода кампуса",
      level: 2,
      chunks: [
        {
          id: "section-campus-metrics-chunk-1",
          content: primary.campusMetrics
            .map(
              (metric) => `${metric.label}: ${metric.value} (${metric.note})`
            )
            .join(". "),
        },
        {
          id: "section-campus-metrics-chunk-2",
          content: `Тарифы на проживание (ООО «Отельные решения», «Три звезды»): ${primary.tariffs
            .map((tariff) => `${tariff.label} — ${tariff.value}`)
            .join("; ")}.`,
        },
      ],
    });

    sections.push({
      id: "section-campus-entities",
      heading: "Организации и их роли",
      level: 2,
      chunks: [
        {
          id: "section-campus-entities-chunk-1",
          content: primary.legalEntities
            .map((entity) => `${entity.name} — ${entity.role}`)
            .join(". "),
        },
      ],
    });
  } else if (primary.type === "university") {
    const universityCards = params.selectedCards.filter(
      (card): card is UniversityCard => card.type === "university"
    );
    const allMetrics = universityCards.flatMap((card) =>
      (card.structuredMetrics ?? []).map((metric) => ({ card, metric }))
    );
    const opening = allMetrics[0];
    title =
      universityCards.length > 1
        ? "Показатели вузов-резидентов по паспортам"
        : `${getUniversityName(primary.universityId)}: показатели по паспорту вуза`;
    lead = opening
      ? formatUniversityMetric(opening.card, opening.metric)
      : `${getUniversityFullName(primary.universityId)}. Сведения о показателях в утверждённом паспорте отсутствуют. [${primary.id}]`;
    for (const card of universityCards) {
      const metrics = card.structuredMetrics ?? [];
      sections.push({
        id: `section-metrics-${card.universityId}`,
        heading: `Показатели ${getUniversityName(card.universityId)} по годам`,
        level: 2,
        chunks: metrics.length
          ? metrics.slice(0, 12).map((metric, index) => ({
              id: `section-metrics-${card.universityId}-${index}`,
              content: formatUniversityMetric(card, metric),
            }))
          : [
              {
                id: `section-metrics-${card.universityId}-empty`,
                content: `Для ${getUniversityName(card.universityId)} подтверждённых показателей по запросу нет. [${card.id}]`,
              },
            ],
      });
    }
  } else {
    lead = (primary.referenceDescription || primary.title).slice(0, 990);
    sections.push({
      id: "section-custom",
      heading: `Сведения карточки «${primary.title}»`,
      level: 2,
      chunks: [
        {
          id: "section-custom-chunk-1",
          content:
            Object.entries(primary.customFields)
              .map(
                ([k, v]) =>
                  `${k}: ${Array.isArray(v) ? v.join(", ") : String(v ?? "—")}`
              )
              .join("; ") || primary.title,
        },
      ],
    });
  }

  if (primary.type !== "university" && secondaryCards.length > 0) {
    sections.push({
      id: "section-related-context",
      heading: "Связанные объекты и проекты из официальных данных",
      level: 3,
      chunks: secondaryCards.map((card, index) => ({
        id: `section-related-chunk-${index + 1}`,
        content: `${card.title}: ${card.referenceDescription} [${card.id}]`,
      })),
    });
  }

  if (params.referenceChunks.length > 0) {
    sections.push({
      id: "section-colleagues-context",
      heading: "Опорный контекст из библиотеки «Готовые статьи»",
      level: 3,
      chunks: params.referenceChunks.slice(0, 2).map((chunk, index) => ({
        id: `section-colleagues-chunk-${index + 1}`,
        content: `${chunk.content} (опора на материал «${chunk.articleTitle}»)`,
      })),
    });
  }

  if (primary.type !== "university") {
    const citation = ` [${primary.id}]`;
    lead = `${lead.slice(0, 1000 - citation.length)}${citation}`;
    sections
      .filter(
        (section) =>
          section.id !== "section-related-context" &&
          section.id !== "section-colleagues-context"
      )
      .forEach((section) =>
        section.chunks.forEach((chunk) => {
          chunk.content += citation;
        })
      );
  }

  return generatedArticleSchema.parse({
    noData: false,
    noDataMessage: null,
    title,
    lead,
    sections,
    sourceCardIds: params.selectedCards.map((card) => card.id),
    sourceCardTitles: params.selectedCards.map((card) => card.title),
    projectTitle: primary.title,
    topic: fallbackTopic(primary),
    suggestedUniversityId: findUniversityIdForCard(primary) ?? "susu",
    usedArticleIds: params.matchedArticles.map((article) => article.id),
  });
}
