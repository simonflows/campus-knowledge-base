import {
  AUDIT_STOP_RULES,
  FACT_CHECK_PRESETS,
  type AuditStopCategory,
} from "./audit-canon-registry";
import {
  getFolderPathLabel,
  getUniversityById,
  getUniversityFullName,
  getUniversityName,
  getApprovedVersion,
  getUniversityIdFromFolder,
  type UniversityCard,
  placementStatusLabels,
  type CampusCard,
  type KnowledgeCard,
  type LaboratoryCard,
  type ProjectCard,
} from "./knowledge";
import { universities } from "./data";
import {
  knowledgeQueryTerms,
  sameKnowledgeWord,
  tokenizeKnowledgeText,
  withoutSourceUrls,
} from "./knowledge-query";
import { knowledgeCardMatch } from "./knowledge-search";
import {
  claimCoverage,
  claimSpan,
  concreteClaimForm,
  interviewTopic,
  makeClaim,
  nonFactualForm,
  omitsAssertionQualification,
  opinionQualifierEnd,
  type ClaimCoverage,
  type ClaimSpan,
  type FactClaim,
} from "./fact-claims";

export const FACT_CHECK_CHECKPOINTS = {
  campus: "Общие параметры кампуса",
  placement: "Статус и размещение объекта",
  authorship: "Авторство и соисполнители",
  contour: "Разделение контуров",
  names: "Официальные названия и должности",
  figures: "Неподтверждённые цифры",
} as const;

export type FactCheckCheckpoint = keyof typeof FACT_CHECK_CHECKPOINTS;

export const FACT_CHECK_LEVELS = ["red", "yellow", "green"] as const;

export type FactCheckLevel = (typeof FACT_CHECK_LEVELS)[number];

export const levelLabels: Record<FactCheckLevel, string> = {
  red: "Красный",
  yellow: "Жёлтый",
  green: "Зелёный",
};

export const levelDescriptions: Record<FactCheckLevel, string> = {
  red: "Прямое искажение — публикация запрещена до правки",
  yellow: "Нет подтверждения в базе — требуется уточнение",
  green: "Факт подтверждён официальной карточкой",
};

export type FactCheckFinding = {
  id: string;
  level: FactCheckLevel;
  checkpoint: FactCheckCheckpoint;
  checkpointLabel: string;
  title: string;
  quote: string;
  explanation: string;
  suggestion: string;
  sourceCardId: string | null;
  sourceCardTitle: string | null;
  sourceFolder: string | null;
  sourceUrl?: string | null;
  sourceVersionId?: string;
  sourceField?: string;
  quoteStart?: number;
  quoteEnd?: number;
  replacement?: string;
};

export type FactCheckSummary = {
  red: number;
  yellow: number;
  green: number;
  total: number;
};

export type FactCheckCheckpointSummary = {
  key: FactCheckCheckpoint;
  label: string;
  red: number;
  yellow: number;
  green: number;
};

export type FactCheckResult = {
  findings: FactCheckFinding[];
  summary: FactCheckSummary;
  checkpoints: FactCheckCheckpointSummary[];
  canPublish: boolean;
  checkedChars: number;
  coverage: "confirmed" | "partial" | "unverified";
  claimCoverage?: ClaimCoverage;
  claims?: FactClaim[];
};

export type CanonicalRewriteChunk = {
  id: string;
  content: string;
};

export type CanonicalRewriteSection = {
  id: string;
  heading: string;
  level: 2 | 3;
  chunks: CanonicalRewriteChunk[];
};

export type CanonicalRewrite = {
  title: string;
  lead: string;
  sections: CanonicalRewriteSection[];
  sourceCardIds: string[];
  sourceCardTitles: string[];
  plainText: string;
  preservedText?: string;
  changes?: Array<{ before: string; after: string; sourceCardId: string }>;
  sourceVersions?: Record<string, string>;
};

export const FACT_CHECK_EXAMPLE_TEXT =
  "В новом учебно-научном корпусе кампуса «Южный Урал» в Челябинске уже работает уникальная медицинская VR-лаборатория, полностью разработанная одним из вузов-резидентов. В 2025 году здесь создали виртуальный тренажёр травмпункта, через который уже прошли обучение более 5000 врачей области. Общая площадь кампуса на сегодня составляет 110 тыс. кв. метров";

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .trim();
}

function tokenRoots(value: string): string[] {
  return normalize(value)
    .split(/\s+/)
    .filter((token) => token.length >= 4)
    .map((token) => token.slice(0, 5));
}

function uniqueRoots(value: string): string[] {
  return Array.from(new Set(tokenRoots(value)));
}

function termMatches(term: string, draftRoots: Set<string>): boolean {
  const cleaned = term.replace(/\([A-ZА-Я0-9\s._-]{3,32}\)/g, " ");
  const roots = uniqueRoots(cleaned);

  if (roots.length === 0) return false;

  const matched = roots.filter((root) => draftRoots.has(root)).length;
  const required =
    roots.length === 1
      ? 1
      : roots.length === 2
        ? 2
        : Math.ceil(roots.length * 0.65);

  return matched >= required;
}

function distinctiveTermMatches(
  term: string,
  draftRoots: Set<string>
): boolean {
  const roots = uniqueRoots(term);

  if (roots.length < 2 || normalize(term).length < 10) return false;

  const matched = roots.filter((root) => draftRoots.has(root)).length;

  return matched >= Math.ceil(roots.length * 0.75);
}

function isVrLaboratory(card: KnowledgeCard): card is LaboratoryCard {
  if (card.type !== "laboratory") return false;

  const text = normalize(
    [
      card.title,
      ...card.workDirections,
      ...card.equipment,
      card.referenceDescription,
    ].join(" ")
  );

  return text.includes("vr");
}

function cardReferenceTerms(card: KnowledgeCard): string[] {
  const terms: string[] = [card.title];

  if (card.type === "project") {
    terms.push(card.sphere, card.industrialPartner);
    terms.push(...card.confirmedFigures);

    if (card.isJoint) {
      terms.push(
        card.participantUniversityIds
          .map((universityId) => getUniversityFullName(universityId))
          .join(" и ")
      );
    }
  }

  if (card.type === "laboratory") {
    terms.push(
      card.affiliation,
      ...card.workDirections,
      ...card.equipment,
      ...card.confirmedIndicators
    );
  }

  if (card.type === "campus") {
    terms.push(
      "кампус «Южный Урал»",
      ...card.campusMetrics.map((metric) => metric.label)
    );
  }

  return terms.filter((term) => term.trim().length > 0);
}

function isCardReferenced(
  card: KnowledgeCard,
  draftRoots: Set<string>,
  normalizedDraft: string
): boolean {
  if (termMatches(card.title, draftRoots)) return true;

  if (
    isVrLaboratory(card) &&
    normalizedDraft.includes("vr") &&
    normalizedDraft.includes("лаборатор")
  ) {
    return true;
  }

  const nonTitleMatches = cardReferenceTerms(card)
    .slice(1)
    .filter((term) => distinctiveTermMatches(term, draftRoots));

  return nonTitleMatches.length >= 2;
}

function isSentenceBoundary(text: string, index: number): boolean {
  if (text[index] === "\n" || text[index] === "\r") return true;
  if (
    !/[.!?]/.test(text[index]) ||
    (index + 1 < text.length && !/\s/.test(text[index + 1]))
  )
    return false;
  if (
    text[index] === "." &&
    /(?:тыс|кв|г|гг|гост|корп|уч|млн|млрд|авг|сент|эт|студ|им|пр|ул|лаб|(?<![а-яё])[а-яё])\.$/i.test(
      text.slice(Math.max(0, index - 8), index + 1)
    )
  )
    return false;
  return true;
}

function sentenceAt(text: string, index: number, original = text): string {
  let start = 0;
  let end = text.length;

  for (let i = index; i >= 0; i -= 1) {
    if (isSentenceBoundary(text, i)) {
      start = i + 1;
      break;
    }
  }

  for (let i = index; i < text.length; i += 1) {
    if (isSentenceBoundary(text, i)) {
      end = i + 1;
      break;
    }
  }

  const sentence = original.slice(start, end).trim();

  return sentence;
}

function sourceFromCard(card: KnowledgeCard) {
  return {
    sourceCardId: card.id,
    sourceCardTitle: card.title,
    sourceFolder: getFolderPathLabel(card.folderId),
  };
}

function parseNumeric(value: string): number {
  const firstBound = value.split(/[–—-]/)[0] ?? value;
  const cleaned = firstBound
    .replace(/\s+/g, "")
    .replace(/,/g, ".")
    .replace(/[^\d.]/g, "");

  return Number.parseFloat(cleaned);
}

function formatArea(value: number): string {
  return `${value.toLocaleString("ru-RU").replace(/\u00a0/g, " ")} м²`;
}

function resolveQueue(value: string): "first" | "second" | "third" | null {
  const normalized = normalize(value);

  if (
    normalized === "iii" ||
    normalized === "3" ||
    normalized.startsWith("трет")
  ) {
    return "third";
  }

  if (
    normalized === "ii" ||
    normalized === "2" ||
    normalized.startsWith("втор")
  ) {
    return "second";
  }

  if (
    normalized === "i" ||
    normalized === "1" ||
    normalized.startsWith("перв")
  ) {
    return "first";
  }

  return null;
}

const AUDIT_CATEGORY_TO_CHECKPOINT: Record<
  AuditStopCategory,
  FactCheckCheckpoint
> = {
  campus_params: "campus",
  placement_status: "placement",
  coauthorship: "authorship",
  contours: "contour",
  names_entities: "names",
  unverified_metrics: "figures",
};

type CampusAreaScope = "land" | "academic" | "hotel" | "housing" | "campus";
const areaNumber = String.raw`[-−]?\d[\d.,\p{Zs}\t]*?`;
const areaQuantity = String.raw`(${areaNumber})(?:[–—-][\p{Zs}\t]*(${areaNumber}))?\s*(тыс\.?\s*)?`;
const campusAreaMeasurement = new RegExp(areaQuantity + String.raw`(?:кв\.?\s*метр[а-яё]*|кв\.?\s*м(?:2|²)?|м(?:2|²)|квадратн[а-яё]*\s+метр[а-яё]*)(?![\p{L}\p{N}])`, "iu");

function parseAreaNumber(value: string): number {
  return /^[-−]/u.test(value) ? -parseNumeric(value.slice(1)) : parseNumeric(value);
}

function campusAreaScope(text: string): CampusAreaScope | null {
  if (/земл|зем[её]л|участ(?:ок|к[а-яё]*)/iu.test(text)) return "land";
  if (/(?<![а-яё])унк(?![а-яё])|учебно[- ]научн/iu.test(text)) return "academic";
  if (/гостини[цч]|общежити/iu.test(text)) return "hotel";
  if (/жил[а-яё]*\s+част|жилая|жилой/iu.test(text)) return "housing";
  if (/общ[а-яё]*\s+площад|площад[а-яё]*\s+(?:объект|кампус)/iu.test(text)) return "campus";
  return null;
}

function campusAreaEvidence(card: CampusCard, scope: CampusAreaScope | null) {
  if (!scope) return [];
  const sources = card.campusMetrics
    .filter(({ label }) => /площад/iu.test(label))
    .flatMap(({ label, value, note }) => [
      ...(campusAreaScope(label) === scope ? [`${label}: ${value}`] : []),
      ...note.split(/[,;](?!\d)/u).filter((part) => campusAreaScope(part) === scope),
    ]);
  const pattern = new RegExp(areaQuantity + String.raw`(?:м²|м2|кв\.?\s*м(?:етр[а-яё]*)?)`, "giu");
  return sources.flatMap((source) => Array.from(source.matchAll(pattern), (match) => {
    const multiplier = match[3] ? 1_000 : 1;
    return {
      source: source.trim(),
      low: parseAreaNumber(match[1]) * multiplier,
      high: parseAreaNumber(match[2] ?? match[1]) * multiplier,
    };
  })).filter(({ low, high }) => Number.isFinite(low) && Number.isFinite(high));
}

function campusMeasureSources(
  card: CampusCard,
  kind: "cost" | "places",
  claim: string
): string[] {
  let sources: string[] = [];
  if (kind === "cost") {
    const scope = /капитальн\p{L}*\s+грант/iu.test(claim) ? /капитальн\p{L}*\s+грант/iu
      : /концесси/iu.test(claim) ? /концесси/iu
      : /совокупн\p{L}*\s+объ[её]м\s+инвестиц/iu.test(claim) ? /совокупн\p{L}*\s+объ[её]м\s+инвестиц/iu
      : null;
    if (!scope || !/₽|рубл/iu.test(claim)) return [];
    sources = card.campusMetrics.flatMap(({ label, value, note }) => [
      ...(scope.test(label) ? [label + ": " + value] : []),
      ...note.split(/;\s*/u).filter(part => scope.test(part)),
    ]).filter(source => {
      const year = /\b(?:19|20|21)\d{2}\b/u.exec(source)?.[0];
      const statementYear = /\b(?:19|20|21)\d{2}\b/u.exec(claim)?.[0];
      return year === statementYear &&
        /(?<!\p{L})до\s+\d/iu.test(source) === /(?<!\p{L})до\s+\d/iu.test(claim);
    });
  } else {
    const queue = /перв|(?<!\d)1[- ]?я/i.test(claim)
      ? "first"
      : /втор|(?<!\d)2[- ]?я/i.test(claim)
        ? "second"
        : null;
    if (queue) {
      const markers = Array.from(
        card.referenceDescription.matchAll(/(1|2|3)[- ]?я\s+очеред[а-яё]*/gi)
      );
      const markerIndex = markers.findIndex(
        (match) => resolveQueue(match[1]) === queue
      );
      if (markerIndex >= 0)
        sources = [
          card.referenceDescription.slice(
            markers[markerIndex].index,
            markers[markerIndex + 1]?.index ?? card.referenceDescription.length
          ),
        ];
    } else if (/(?:гостиниц|общежити|для\s+проживан|жилых\s+мест)/iu.test(claim))
      sources = card.campusMetrics
        .filter((metric) => /вместимость/i.test(metric.label))
        .flatMap((metric) => [metric.value, metric.note]);
  }
  return sources;
}

function isOfficialCampusMeasure(
  card: CampusCard,
  kind: "cost" | "places",
  value: number,
  claim: string
): boolean {
  const sources = campusMeasureSources(card, kind, claim);
  const unit = kind === "cost" ? "млрд" : "мест[а-яё]*";
  const pattern = new RegExp(
    `(\\d[\\d \u00a0.,]*?)(?:[–—-](\\d[\\d \u00a0.,]*?))?\\s*(тыс\\.?\\s*)?${unit}`,
    "gi"
  );
  return sources.some((source) =>
    Array.from(source.matchAll(pattern)).some((match) => {
      const low = parseNumeric(match[1]);
      const high = parseNumeric(match[2] ?? match[1]);
      return value >= low && value <= high;
    })
  );
}

function campusMeasureContext(draft: string, index: number): string {
  const clause = claimClause(draft, index);
  const prefix = draft.slice(Math.max(0, index - 220), index);
  const marker = Array.from(
    prefix.matchAll(
      /(?:[123][- ]?я|перв[а-яё]*|втор[а-яё]*|трет[а-яё]*)(?:\s+(?:очеред[а-яё]*|этап[а-яё]*)|\s*(?=\())/gi
    )
  ).at(-1);
  return marker &&
    !/[.!?]\s+[А-ЯЁ]/.test(prefix.slice(marker.index! + marker[0].length))
    ? `${marker[0]} ${clause}`
    : clause;
}

function officialQueueYears(
  card: CampusCard,
  queue: "first" | "second" | "third"
): number[] {
  const markers = Array.from(
    card.referenceDescription.matchAll(/([123])[- ]?я\s+очеред[а-яё]*/gi)
  );
  const index = markers.findIndex((match) => resolveQueue(match[1]) === queue);
  if (index < 0) return [];
  return Array.from(
    card.referenceDescription
      .slice(
        markers[index].index,
        markers[index + 1]?.index ?? card.referenceDescription.length
      )
      .matchAll(/\b(?:19|20|21)\d{2}\b/g)
  ).map((match) => Number(match[0]));
}

const singleAuthorPatterns: RegExp[] = [
  /одн(?:им|ого|ому)\s+(?:из\s+)?вуз[а-яё]*/i,
  /одним\s+вузом/i,
  /единственн[а-яё]*\s+(?:автор|разработчик|вуз)[а-яё]*/i,
  /полностью\s+разраб[а-яё]*/i,
  /самостоятельно\s+разраб[а-яё]*/i,
  /силами\s+одного\s+вуз[а-яё]*/i,
  /принадлежит\s+одному\s+вуз[а-яё]*/i,
];

const authorVerb =
  /(?:разработ[а-яё]*|созда[а-яё]*|сделан[а-яё]*|принадлеж[а-яё]*|автор[а-яё]*)/iu;
const soleNamedAuthorVerb =
  /(?:разработал[аи]?|создал[аи]?|разработан[а-яё]*|создан[а-яё]*|принадлежит)/iu;
const activePlacementPattern =
  /(?:работа(?:ет|ют|л[аи]?)|действу(?:ет|ют)|функциониру[а-яё]*|введ[её]н[а-яё]*\s+в\s+эксплуатацию|открыт(?:а|ы|о|ый|ых|ая)?|запущен[а-яё]*)(?![\p{L}])/iu;
const campusPlacementPattern =
  /(?:в|на)\s+(?:новом\s+)?(?:унк(?![а-яё])|учебно[- ]научн[а-яё]*\s+(?:корпус[а-яё]*|комплекс[а-яё]*)|кампус[а-яё]*|корпус[а-яё]*\s+кампус[а-яё]*)/iu;
const futurePlacement =
  /(?:планиру[а-яё]*|до\s+(?:завершения|открытия|ввода)|после\s+(?:ввода|открытия)|буд(?:ет|ут))(?![\p{L}])/iu;
const plannedOpening =
  /планиру[а-яё]*\s+(?:к\s+открытию|открытие|открыть)|откроется|(?:открытие|ввод)\s+запланирован[а-яё]*/iu;
const presentTime =
  /(?:сейчас|сегодня|пока|ещ[её]|в\s+настоящее\s+время|на\s+данный\s+момент)/iu;
const presentPrefix = new RegExp("^" + presentTime.source + "\\s+", "iu");
const presentDenial = new RegExp(
  "^(.+?)\\s+(?:(" +
    presentTime.source +
    ")\\s+)?не\\s+(?:работает|действует|функционирует|открыт[ао]?|запущен[ао]?)\\s*[.!]*$",
  "iu"
);
const openingAndDenial = new RegExp(
  "^(.+?)\\s+(?:(?:только|лишь)\\s+)?(?:" +
    plannedOpening.source +
    ")(?:\\s+(?!и(?:\\s|$))[^\\s,.!?;]+){0,16}\\s+и$",
  "iu"
);
const openingOnly = new RegExp(
  "^(.+?)\\s+(?:" +
    presentTime.source +
    "\\s+)?(?:только|лишь)\\s+(?:" +
    plannedOpening.source +
    ")\\s*[.!]*$",
  "iu"
);
const previousSubject =
  /^\s*(?:он[аи]?|эт(?:от|а|о|и)\s+(?:проект|объект|лаборатор[а-яё]*|тренаж[её]р|робот))\s/iu;
const statementSegmenter = new Intl.Segmenter("ru", {
  granularity: "sentence",
});
const abbreviationDot =
  /(?<![\p{L}\p{N}])(?:им|г|гг|ул|пр|корп|тыс|млн|млрд|кв|лаб|гост|эт|[А-ЯA-Z])\.(?=\s|[)])|(?<=ВЭБ)\.(?=РФ)/gu;

export function factCheckSentenceRanges(line: string) {
  const masked = line.replace(/[\r\n]/gu, " ").replace(
    abbreviationDot,
    (value) => value.slice(0, -1) + "·"
  );
  return Array.from(
    statementSegmenter.segment(masked),
    ({ index, segment }) => ({
      index,
      text: line.slice(index, index + segment.length),
    })
  );
}

const contrastSeparator = /;\s+|,\s+(?:а|но|тогда\s+как)\s+/iu;
const listMarker = /^[^\S\r\n]*(?:[-+*•▪◦]|(?!(?:19|20|21)\d{2}[.)])\d+[.)])[^\S\r\n]+/u;
const speechMarker = /^[^\S\r\n]*[—–][^\S\r\n]+/u;
const markdownHeading = /^#{1,6}[^\S\r\n]+/u;
const bareCampusHeading = /^(?:межуниверситетский\s+)?кампус\s+(?:[«"„“][^»"“”]+[»"“”]|Южный\s+Урал)\s*:?$/iu;
const sentenceEnd = /[.!?…][»”"')\]]*$/u;
const continuationWord = /(?:^|\s)(?:в|во|на|при|к|ко|с|со|из|от|до|для|под|над|и|или|в\s+городе|г·)$/iu;
const numericPredicate = /(?:^|\s)(?:составля\p{L}*|насчитыва\p{L}*|равн[аоы]?|получил[аи]?)$/iu;

function isSoftLineWrap(previous: string, next: string) {
  const maskedPrevious = (previous.trimEnd() + " ").replace(abbreviationDot, value => value.slice(0, -1) + "·").trimEnd();
  const numberContinues = /^\d/u.test(next) && (
    numericPredicate.test(maskedPrevious) ||
    /\d$/u.test(maskedPrevious) && /^\d{3}(?![\p{L}\p{N}-])/u.test(next)
  );
  return !sentenceEnd.test(maskedPrevious) && !/:$/u.test(maskedPrevious) &&
    (numberContinues || /^[\p{Ll}«„“"]/u.test(next) || continuationWord.test(maskedPrevious) ||
     maskedPrevious.lastIndexOf("«") > maskedPrevious.lastIndexOf("»"));
}

function isMeasurementDashWrap(previous: string, next: string): boolean {
  if (!/[—–-]\s*$/u.test(previous) && !/^[—–-]\s*\d/u.test(next)) return false;
  const subject = factCheckSentenceRanges(previous).at(-1)?.text.trim() ?? "";
  const combined = factCheckSentenceRanges(subject + " " + next)[0]?.text.trim().replace(/[\r\n]/gu, " ") ?? "";
  return !!hotelCapacityAssertion(combined) ||
    !!campusAreaScope(subject) && !!campusAreaMeasurement.exec(combined)?.[2];
}

type StatementSpan = ClaimSpan & { frameStart: number; frameEnd: number };
type SentenceFrame = {
  start: number;
  end: number;
  text: string;
  standalone: boolean;
  listItem: boolean;
};

/** Segment prose with original offsets, keeping explicit headings and list items apart. */
function factCheckFrames(text: string): SentenceFrame[] {
  const blocks: { start: number; end: number; listItem: boolean; heading: boolean }[] = [];
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    const trimmed = line[0].trimStart();
    if (!trimmed) continue;
    const marker = listMarker.exec(line[0]);
    const heading = markdownHeading.test(trimmed) || bareCampusHeading.test(trimmed);
    const previous = blocks.at(-1);
    const end = line.index + line[0].length;
    if (previous && !previous.heading && !heading && !marker &&
        /^(?:\r\n|[\r\n])$/u.test(text.slice(previous.end, line.index))) {
      const before = text.slice(previous.start, previous.end);
      if (isMeasurementDashWrap(before, trimmed) || !speechMarker.test(trimmed) && isSoftLineWrap(before, trimmed)) {
        previous.end = end;
        continue;
      }
    }
    blocks.push({ start: line.index + (marker?.[0].length ?? 0), end, listItem: !!marker, heading });
  }
  return blocks.flatMap(block => {
    const sentences = factCheckSentenceRanges(text.slice(block.start, block.end));
    return sentences.map(sentence => ({
      start: block.start + sentence.index,
      end: block.start + sentence.index + sentence.text.length,
      text: sentence.text,
      standalone: sentences.length === 1,
      listItem: block.listItem,
    }));
  });
}

/** Existing clause rules see the same content and offsets across soft wraps. */
function maskSoftLineWraps(text: string, frames: SentenceFrame[]): string {
  let start = 0;
  const parts: string[] = [];
  for (const frame of frames) {
    if (!/[\r\n]/u.test(frame.text)) continue;
    parts.push(text.slice(start, frame.start), text.slice(frame.start, frame.end).replace(/[\r\n]/gu, " "));
    start = frame.end;
  }
  return parts.join("") + text.slice(start);
}

export function factCheckClaimSpans(text: string): (StatementSpan & { standalone: boolean })[] {
  return spansFromFrames(text, factCheckFrames(text));
}

function spansFromFrames(text: string, frames: SentenceFrame[]) {
  const separators = new RegExp(contrastSeparator.source + "|" + interviewTopic.source, "giu");
  return frames.flatMap(({ start, end, text: sentence, standalone, listItem }) => {
    const parts: StatementSpan[] = [];
    const add = (left: number, right: number) => {
      parts.push({ ...claimSpan(text, start + left, start + right), frameStart: start, frameEnd: end });
    };
    let previous = opinionQualifierEnd(sentence);
    if (previous > 0) add(0, previous);
    for (const separator of sentence.matchAll(separators)) {
      if (separator.index < previous) continue;
      add(previous, separator.index);
      previous = separator.index + separator[0].length;
    }
    add(previous, sentence.length);
    return parts.filter(({ quote }) => quote).map(part => ({
      ...part,
      standalone: standalone && (!listItem || bareCampusHeading.test(sentence.trim())) && parts.length === 1,
    }));
  });
}

export function factCheckStatements(text: string): string[] {
  return factCheckFrames(text)
    .flatMap(frame => frame.text.split(contrastSeparator))
    .map(statement => statement.trim())
    .filter(Boolean);
}

function locallyNegated(claim: string, index: number): boolean {
  const prefix = claim.slice(Math.max(0, index - 72), index);
  return /(?:^|[^\p{L}])(?:не(?!\s+только)|нельзя|запрещено)(?:\s+[\p{L}-]+){0,6}\s*[«„"']?\s*$/iu.test(
    prefix
  );
}

function affirmed(claim: string, pattern: RegExp): boolean {
  return [...claim.matchAll(new RegExp(pattern.source, "giu"))].some(
    (match) => !locallyNegated(claim, match.index)
  );
}

const contourClaims: Array<{
  contour: ProjectCard["contour"];
  wording: RegExp;
}> = [
  {
    contour: "ПИШ",
    wording:
      /(?<![\p{L}\p{N}])пиш(?![\p{L}\p{N}])|передов[а-яё]*\s+инженерн[а-яё]*\s+школ[а-яё]*/iu,
  },
  {
    contour: "УМНОЦ",
    wording:
      /(?<![\p{L}\p{N}])умноц(?![\p{L}\p{N}])|межвузовск[а-яё]*\s+научно[- ]образовательн[а-яё]*/iu,
  },
  {
    contour: "собственный проект вуза",
    wording: /собственн[а-яё]*\s+(?:проект[а-яё]*\s+вуза|инициатив[а-яё]*)/iu,
  },
  {
    contour: "кампус",
    wording: /(?:контур[а-яё]*|в\s+рамках|продукт[а-яё]*)\s+«?кампус[а-яё]*/iu,
  },
];
const contourCue =
  /контур|относ[иия][а-яё]*\s+к|проект[а-яё]*\s+(?:пиш|умноц)|в\s+(?:рамках|пиш|умноц)|контекст[а-яё]*\s+программ|передов[а-яё]*\s+инженерн[а-яё]*\s+школ[а-яё]*|собственн[а-яё]*\s+проект|продукт[а-яё]*\s+кампуса/iu;

function projectTitle(card: KnowledgeCard) {
  return card.title.replace(/\s*\([A-ZА-Я0-9\s._-]{3,32}\)\s*$/u, "").trim();
}

function scopedCards<T extends KnowledgeCard>(
  statement: string,
  candidates: T[]
): T[] {
  const text = " " + normalize(statement) + " ";
  const exact = candidates.filter((card) =>
    [card.id, projectTitle(card)].some((part) => {
      const name = normalize(part);
      return name.length >= 5 && text.includes(" " + name + " ");
    })
  );
  if (exact.length) return exact;
  const roots = new Set(tokenRoots(statement));
  return candidates.filter(
    (card) =>
      distinctiveTermMatches(projectTitle(card), roots) ||
      (card.type === "laboratory" &&
        card.equipment.some((equipment) => {
          const names =
            equipment.match(
              /(?<![\p{L}\p{N}])(?=[A-Za-z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{2,}(?![\p{L}\p{N}])/gu
            ) ?? [];
          return names.some((name) =>
            text.includes(" " + normalize(name) + " ")
          );
        })) ||
      (isVrLaboratory(card) &&
        /vr[\s-]+лаборатор|лаборатор[а-яё]*[\s-]+[^.!?]{0,30}\bvr\b/iu.test(
          statement
        ))
  );
}

function uniqueScopedCard<T extends KnowledgeCard>(
  statement: string,
  candidates: T[]
): T | undefined {
  const scoped = scopedCards(statement, candidates);
  return scoped.length === 1 ? scoped[0] : undefined;
}

export function deniesCurrentOperation(
  statement: string,
  lab: LaboratoryCard,
  labs: LaboratoryCard[]
): boolean {
  if (lab.placementStatus !== "active" || statement.length > 500) return false;
  const claim = statement.replace(presentPrefix, "");
  const denial = presentDenial.exec(claim);
  const precedingPlan = denial && openingAndDenial.exec(denial[1]);
  // A coordinated denial after a plan must explicitly refer to the present.
  if (precedingPlan && !denial[2] && claim === statement) return false;
  const subject =
    precedingPlan?.[1] ?? denial?.[1] ?? openingOnly.exec(claim)?.[1];
  if (!subject) return false;

  // Resolve the complete subject before scoring a negative claim. The alias
  // may connect the lab and its equipment with «с» in place of «и».
  const withoutLinkers = (text: string) =>
    tokenizeKnowledgeText(text)
      .filter((word) => !/^(?:и|с|со)$/u.test(word))
      .join(" ");
  const names = labs.filter((card) =>
    [projectTitle(card), card.title, card.id].some((name) =>
      equivalentWords(withoutLinkers(subject), withoutLinkers(name))
    )
  );
  return names.length === 1 && names[0].id === lab.id;
}

const currentUniversitySite =
  /(?:на\s+площадке|действующ\p{L}*\s+площадка)\s+([^;,.!?()]+)/iu;
const historicalPlacement = /(?<!\p{L})(?:раньше|ранее|прежде|в\s+прошлом|бывш\p{L}*|работал[аио]?|действовал[аио]?)(?!\p{L})/iu;
const verifiedCurrentPlacement =
  /(?<!\p{L})(?:работа(?:ет|ют)|действу(?:ет|ют)|действующ\p{L}*|функциониру(?:ет|ют))(?!\p{L})/iu;
const simpleCampusSite =
  /^в\s+(?:новом\s+)?(?:унк(?:\s+кампуса)?|(?:учебно[- ]научном\s+)?корпусе\s+кампуса|кампусе)(?:\s+[«"„“]южный\s+урал[»"“”])?$/iu;
const placementOperation = /(?:работает|действует|функционирует)/iu;
const subjectAtSite = new RegExp(
  /^(?:(?:сейчас|сегодня)\s+)?([^,;.!?]+?)\s+(?:(?:сейчас|уже)\s+)?/iu.source +
  placementOperation.source + /\s+((?:в|на)\s+[^,;.!?]+)/iu.source,
  "iu"
);
const siteBeforeSubject = new RegExp(
  /^((?:в|на)\s+[^,;.!?]+?)\s+/iu.source + placementOperation.source + /\s+([^,;.!?]+)/iu.source,
  "iu"
);
const relativeSite =
  /^([^,\s]+)\s+описывает\s+действующ\p{L}*\s+на\s+площадке\s+института\s+(?:центр|лаборатори\p{L}+)(?!\p{L})[^,]*,\s+где\s+([^,;.!?]+?)\s+(?:помогает|работает|действует|функционирует)(?!\p{L})/iu;
const placementNegation = /(?<!\p{L})(?:не|ни|никогда|отнюдь)(?!\p{L})/iu;
const qualifiedPlacement = /[?？]|(?<!\p{L})(?:если|при\s+условии|в\s+случае|возможно|вероятно)(?!\p{L})/iu;

function labUniversity(lab: LaboratoryCard) {
  const affiliations = universitiesIn(lab.affiliation);
  return getUniversityIdFromFolder(lab.folderId) ?? (affiliations.length === 1 ? affiliations[0] : undefined);
}

function universitySiteMatch(part: string, university: string | undefined): "named" | "host" | undefined {
  if (campusPlacementPattern.test(part)) return;
  const site = currentUniversitySite.exec(part)?.[1].trim();
  if (!site) return;
  const siteWords = tokenizeKnowledgeText(site);
  if (university && [getUniversityName(university), getUniversityFullName(university)].some(alias => {
    const words = tokenizeKnowledgeText(alias);
    return words.length > 0 && words.every((word, index) => sameKnowledgeWord(word, siteWords[index] ?? ""));
  })) return "named";
  if (/^(?:вуза|института|университета)(?:\s+(?:с|в)\s+|$)/iu.test(site)) return "host";
}

function currentPlacementParts(evidence: string) {
  return factCheckStatements(evidence).filter(part =>
    !futurePlacement.test(part) && !datedYear.test(part) && !historicalPlacement.test(part) &&
    !placementNegation.test(part) && !qualifiedPlacement.test(part) && affirmed(part, verifiedCurrentPlacement)
  );
}

function equipmentModelInClaim(mention: EquipmentMention, lab: LaboratoryCard) {
  return lab.id === "lab-midis-kuka" && /^робот/iu.test(mention.kind) && /^куки$/iu.test(mention.model)
    ? "kuka" : normalize(mention.model);
}

/** Associate the location only with the grammatical subject in an affirmative source statement. */
function currentLocationsOf(
  evidence: string,
  lab: LaboratoryCard,
  labs: LaboratoryCard[],
  equipment?: EquipmentMention
) {
  const university = labUniversity(lab);
  const models = recordedEquipmentModels(labs);
  const subjectMatches = (subject: string) => {
    if (!equipment) return officialScope(subject.trim(), labs)?.id === lab.id;
    const name = subject.replace(/^промышленн\p{L}*\s+/iu, "").trim();
    const mentions = namedEquipmentMentions(name, models);
    if (mentions.length !== 1) return false;
    const [mention] = mentions;
    const kind = normalize(mention.kind);
    const expectedKind = normalize(equipment.kind);
    const kindMatches = !kind || !expectedKind || kind === expectedKind ||
      [kind, expectedKind].every(value => /^(?:робот(?: манипулятор)?|манипулятор)$/u.test(value));
    return normalize(name) === normalize([mention.kind, mention.model, mention.variant].join(" ")) &&
      kindMatches &&
      sameKnowledgeWord(equipmentModelInClaim(mention, lab), equipmentModelInClaim(equipment, lab)) &&
      normalize(mention.variant) === normalize(equipment.variant);
  };
  return currentPlacementParts(evidence).flatMap(part => {
    const direct = subjectAtSite.exec(part);
    if (direct) return subjectMatches(direct[1]) ? [direct[2].trim()] : [];
    const reversed = siteBeforeSubject.exec(part);
    if (reversed) return subjectMatches(reversed[2]) ? [reversed[1].trim()] : [];
    const relative = relativeSite.exec(part);
    if (relative && university && equivalentWords(relative[1], getUniversityName(university)) && subjectMatches(relative[2])) {
      return ["на площадке " + getUniversityName(university)];
    }
    return [];
  });
}

/** Verify an ordinary present-tense placement claim using a complete source field. */
export function currentLabPlacementVerdict(
  statement: string,
  lab: LaboratoryCard,
  labs: LaboratoryCard[],
  evidence: string
): "supported" | "contradicted" | undefined {
  if (lab.placementStatus !== "active" || /гипотетическ|опровергнут|неверно утверждать|пример\p{L}*\s+выдум/iu.test(evidence)) return;
  const match = /^(?:(?:сейчас|сегодня)\s+)?(.+?)\s+(?:уже\s+)?(?:работает|действует|функционирует)\s+((?:в|на)\s+[^.!?]+)[.]?$/iu.exec(statement.trim());
  if (!match) return;
  const [, subject, location] = match;
  const equipment = namedEquipmentMentions(subject, recordedEquipmentModels(labs));
  const name = equipment.length === 1 ? normalize(
    [equipment[0].kind, equipment[0].model, equipment[0].variant].filter(Boolean).join(" ")
  ) : "";
  const scoped = name === normalize(subject)
    ? scopedEquipmentLab(equipment, labs, statement)
    : officialScope(subject, labs);
  if (scoped?.id !== lab.id) return;
  const university = labUniversity(lab);
  const activeLocations = currentLocationsOf(evidence, lab, labs, name === normalize(subject) ? equipment[0] : undefined);
  const universitySites = activeLocations.map(part => universitySiteMatch(part, university));
  const atCampus = activeLocations.some(part => campusPlacementPattern.test(part));
  if (simpleCampusSite.test(location)) {
    if (atCampus && activeLocations.some(part => normalize(part) === normalize(location))) return "supported";
    if (universitySites.some(Boolean) && !atCampus) return "contradicted";
  }
  const universityName = /^на\s+площадке\s+(.+)$/iu.exec(location)?.[1];
  if (universityName && universitySites.some(Boolean) && /^(?:вуза|института)$/iu.test(universityName)) return "supported";
  if (universityName && university && universitySites.includes("named") &&
      (equivalentWords(universityName, getUniversityName(university)) ||
        equivalentWords(universityName, getUniversityFullName(university)))) return "supported";
}

function collectScopedFindings(
  input: string,
  statements: DraftStatement[],
  projects: ProjectCard[],
  labs: LaboratoryCard[]
): FactCheckFinding[] {
  const findings: FactCheckFinding[] = [];
  const scoped = new Map<
    string,
    { project?: ProjectCard; lab?: LaboratoryCard }
  >();
  const models = recordedEquipmentModels(labs);
  let previousProject: ProjectCard | undefined;
  let previousLab: LaboratoryCard | undefined;
  for (const [index, { text: statement, quoteStart, placementQualification }] of statements.entries()) {
    const anaphora = previousSubject.test(statement);
    let scope = scoped.get(statement);
    if (!scope) {
      const equipment = namedEquipmentMentions(statement, models);
      scope = {
        project: uniqueScopedCard(statement, projects),
        lab: equipment.length
          ? scopedEquipmentLab(equipment, labs, statement)
          : uniqueScopedCard(statement, labs),
      };
      scoped.set(statement, scope);
    }
    const project = scope.project ?? (anaphora ? previousProject : undefined);
    const lab = scope.lab ?? (anaphora ? previousLab : undefined);
    previousProject = project;
    previousLab = lab;

    const sole =
      singleAuthorPatterns.some((pattern) => affirmed(statement, pattern)) &&
      affirmed(statement, authorVerb);
    const next = statements[index + 1];
    const directlyLinked = next?.text ?? "";
    const linkedProject =
      !project &&
      lab &&
      sole &&
      /(?:здесь|в этой лаборатории)\s+(?:созда|разработ)[а-яё]+/iu.test(
        directlyLinked
      )
        ? uniqueScopedCard(directlyLinked, projects)
        : undefined;
    const authorProject = project ?? linkedProject;
    if (authorProject) {
      const participants =
        authorProject.participantUniversityIds.map(getUniversityName);
      const mentionsSingleAuthor =
        authorProject.isJoint &&
        authorProject.participantUniversityIds.filter((id) =>
          universityMentioned(id, statement)
        ).length === 1 &&
        affirmed(statement, soleNamedAuthorVerb) &&
        !/совместн|соисполн|вместе/iu.test(statement);
      if (
        (sole || mentionsSingleAuthor) &&
        (authorProject.isJoint || authorProject.coExecutors.length > 0)
      ) {
        const names = authorProject.isJoint
          ? participants.join(" и ")
          : authorProject.coExecutors.join(", ");
        findings.push(
          createFinding({
            level: "red",
            checkpoint: "authorship",
            title: authorProject.isJoint
              ? "Совместный проект приписан одному вузу"
              : "Не указаны соисполнители проекта",
            quote: linkedProject && next ? input.slice(quoteStart, next.quoteStart + directlyLinked.length) : statement,
            quoteStart,
            explanation:
              "В утверждённой карточке «" +
              authorProject.title +
              "» указаны соисполнители: " +
              names +
              ".",
            suggestion:
              "Укажите роли соисполнителей. Инициатор — " +
              getUniversityName(authorProject.initiatorUniversityId) +
              ".",
            ...sourceFromCard(authorProject),
          })
        );
      }
    }

    if (project && contourCue.test(statement)) {
      for (const { contour, wording } of contourClaims) {
        for (const match of statement.matchAll(
          new RegExp(wording.source, "giu")
        )) {
          const negative = locallyNegated(statement, match.index);
          if (negative !== (contour === project.contour)) continue;
          findings.push(
            createFinding({
              level: "red",
              checkpoint: "contour",
              title: "Утверждение о контуре противоречит карточке",
              quote: statement,
              quoteStart,
              explanation:
                "В действующей карточке проекта указан контур «" +
                project.contour +
                "».",
              suggestion:
                "Укажите контур «" +
                project.contour +
                "» и отделите участие в других программах.",
              ...sourceFromCard(project),
            })
          );
        }
      }
    }

    if (
      lab &&
      !placementQualification &&
      (activePlacementPattern.test(statement) || plannedOpening.test(statement))
    ) {
      const activeHere =
        affirmed(statement, activePlacementPattern) &&
        !futurePlacement.test(statement) &&
        !datedYear.test(statement) &&
        !/раньше|ранее|работал[аио]?|действовал[аио]?/iu.test(statement);
      const campusHere = affirmed(statement, campusPlacementPattern);
      const currentLocations = lab.placementDetails
        .split(/;|,\s*(?=план)/iu)
        .filter((part) => !futurePlacement.test(part));
      const previouslyActive = currentLocations.some((part) =>
        affirmed(part, activePlacementPattern)
      );
      const candidates = namedEquipmentMentions(statement, models);
      const equipment = candidates.length === 1 ? candidates[0] : undefined;
      const evidence = [lab.placementDetails, lab.referenceDescription].join("\n");
      const verifiedLocations = currentLocationsOf(evidence, lab, labs, equipment);
      const currentCampus = verifiedLocations.some(part => campusPlacementPattern.test(part));
      const currentUniversity = verifiedLocations.some(part => universitySiteMatch(part, labUniversity(lab)));
      const currentPlacement = currentLabPlacementVerdict(statement, lab, labs, evidence);
      const years = (value: string) => [
        ...new Set(value.match(/\b(?:19|20|21)\d{2}\b/gu) ?? []),
      ];
      const dates = years(statement);
      const plannedDates = years(
        lab.placementDetails
          .split(/;|,\s*(?=план)/iu)
          .filter((part) => futurePlacement.test(part))
          .join(" ")
      );
      const wrongOpening =
        affirmed(statement, plannedOpening) &&
        dates.length === 1 &&
        plannedDates.length === 1 &&
        dates[0] !== plannedDates[0];
      const contradicts =
        activeHere &&
        ((lab.placementStatus === "planned" &&
          (campusHere || !previouslyActive)) ||
          (lab.placementStatus === "active" && campusHere && currentUniversity && !currentCampus));
      const denial = deniesCurrentOperation(statement, lab, labs);
      if (contradicts || wrongOpening || denial || currentPlacement === "contradicted") {
        const details =
          lab.placementDetails.trim() ||
          placementStatusLabels[lab.placementStatus];
        findings.push(
          createFinding({
            level: "red",
            checkpoint: "placement",
            title: "Статус или площадка лаборатории противоречит карточке",
            quote: statement,
            quoteStart,
            explanation:
              "В действующей карточке «" + lab.title + "»: " + details + ".",
            suggestion: "Укажите размещение по карточке: " + details + ".",
            replacement: denial && presentDenial.test(statement)
              ? statement.replace(/(?<!\p{L})не\s+(?=работает|действует|функционирует)/iu, "")
              : undefined,
            ...sourceFromCard(lab),
          })
        );
      } else if (currentPlacement === "supported") {
        findings.push(createFinding({
          level: "green",
          checkpoint: "placement",
          title: "Действующая площадка подтверждена",
          quote: statement,
          quoteStart,
          explanation: "Указанное размещение совпадает с действующей площадкой в утверждённой карточке.",
          suggestion: "Сохраните размещение и ссылку на карточку.",
          ...sourceFromCard(lab),
        }));
      }
    }
  }
  return findings;
}

function universityMentioned(universityId: string, draft: string): boolean {
  const university = getUniversityById(universityId);

  if (!university) {
    return normalize(draft).includes(normalize(universityId));
  }

  return (
    normalize(draft).includes(normalize(university.shortName)) ||
    normalize(draft).includes(normalize(university.fullName))
  );
}

const noSource = {
  sourceCardId: null,
  sourceCardTitle: null,
  sourceFolder: null,
  sourceUrl: null,
};

function auditSuggestion(ruleId: string, card: KnowledgeCard, fallback: string) {
  if (ruleId === "RULE-KUKA-TRANSCRIPTION" && card.type === "laboratory") {
    const equipment = card.equipment.find((item) => /\bKUKA\b/iu.test(item));
    const name = equipment ? `Название в карточке — «${equipment}». ` : "";
    return name + "Уточните способ изготовления и материал по первоисточнику.";
  }
  if (ruleId === "RULE-245-PRODUCTS-5REGIONS") {
    return "Уточните показатели Челябинска по официальному источнику. Для сводного показателя укажите охват и период.";
  }
  return fallback;
}

/** Scope at the claim, never at the whole document. Commas in decimals stay intact. */
function claimClause(text: string, index: number, original = text): string {
  const separatorAt = (position: number) =>
    /[;\n]/.test(text[position]) ||
    isSentenceBoundary(text, position) ||
    (text[position] === "," && !/\d/.test(text[position + 1] ?? ""));
  let start = index;
  let end = index;
  while (start > 0 && !separatorAt(start - 1)) start--;
  while (end < text.length && !separatorAt(end)) end++;
  return original.slice(start, end).trim();
}

function universitiesIn(value: string): string[] {
  return universities
    .filter((university) => universityMentioned(university.id, value))
    .map((university) => university.id);
}

function scopedUniversity(draft: string, index: number): string | null {
  const clause = claimClause(draft, index);
  const ids = universitiesIn(clause);
  if (ids.length === 1) return ids[0];
  // A statement naming several universities cannot assign one university's number.
  return null;
}

function isCampusClaim(draft: string, index: number): boolean {
  const clause = claimClause(draft, index);
  const sentence = sentenceAt(draft, index);
  return (
    universitiesIn(clause).length === 0 &&
    (/кампус|(?<![а-яё])унк(?![а-яё])|учебно[- ]научн|гостини[цч]|очеред|этап|земл/i.test(
      clause
    ) ||
      (universitiesIn(sentence).length === 0 &&
        /кампус|(?<![а-яё])унк(?![а-яё])|учебно[- ]научн|гостини[цч]/i.test(
          sentence
        )))
  );
}

const campusName = /кампус[а-яё]*\s*[«"„“]([^»"“”]{3,80})[»"“”]/giu;

function namesOtherCampus(sentence: string, card: CampusCard): boolean {
  const title = normalize(card.title);
  return [...sentence.matchAll(campusName)].some(([, name]) => {
    const normalized = normalize(name);
    return normalized !== "южный урал" && !(" " + title + " ").includes(" " + normalized + " ");
  }) || /кампус\p{L}*\s+(?:в\s+)?(?!Челябинск|Южн\p{L}*\s+Урал|МИДиС|ЮУрГУ|ЧелГУ|ЮУГМУ|ЮУрГАУ|МГТУ|ЮУрГГПУ)[А-ЯЁ][а-яё]{2,}(?=\s|[,.)]|$)/u.test(sentence);
}

type HotelScope = "total" | "first" | "second";
const hotelPlaces = String.raw`(?<number>\d+(?:\s+\d{3})*)\s+(?<unit>мест(?:а|о)?)`;
const hotelCampus = String.raw`гостиниц(?:\s+(?<campus>кампуса)(?:\s+[«"„“]Южный\s+Урал[»"“”])?)?`;
const hotelAssertionPrefix = String.raw`^(?:[—–-]\s+)?`;
const hotelCapacityStatements = {
  total: new RegExp(hotelAssertionPrefix + String.raw`(?:(?:общая|проектная)\s+)?вместимость\s+` + hotelCampus +
    String.raw`(?:\s+составляет\s+|\s*[:—–-]\s*|\s+)` + hotelPlaces + "[.!]?$", "iu"),
  queue: new RegExp(hotelAssertionPrefix + String.raw`(?<queue>первая|вторая)\s+очередь\s+` + hotelCampus +
    String.raw`\s+рассчитана\s+на\s+` + hotelPlaces + "[.!]?$", "iu"),
  queueCapacity: new RegExp(hotelAssertionPrefix + String.raw`вместимость\s+(?<queue>первой|второй)\s+очереди\s+` + hotelCampus +
    String.raw`(?:\s+составляет\s+|\s*[:—–-]\s*|\s+)` + hotelPlaces + "[.!]?$", "iu"),
};
const hotelCapacityQueue =
  /(?<![\p{L}\p{N}])([123]|III|II|I|перв\p{L}*|втор\p{L}*|трет\p{L}*)(?:[- ]?[яей])?\s+(?:очеред|этап)\p{L}*/giu;
const unquotedCampusLead = /^(?:#{1,6}\s+)?(?:(?:в|у|на)\s+)?(?:(?:нов|друг|чуж|межуниверситетск)\p{L}*\s+)*кампус\p{L}*\s+(?![«"„“])(.+)$/iu;
const hotelHeadingOwner = /^(?:#{1,6}\s+)?(?:(?:(?:общая|проектная)\s+)?вместимость\s+гостиниц|гостиницы)\s+(.+)$/iu;
const campusRelativePeriod = /(?<!\p{L})(?:(?:до|перед|после)\s+(?:открыти|ввод|запуск|сдач|завершени)\p{L}*|по\s+состоянию\s+на)(?!\p{L})/iu;
const campusContextQualification = /(?<![\p{L}\p{N}])(?:план|проектн\p{L}*|прогноз\p{L}*|планов\p{L}*|будущ\p{L}*|ожидаем\p{L}*|историческ\p{L}*|архивн\p{L}*|(?:19|20|21)\d{2})(?![\p{L}\p{N}])/iu;
const campusMetricQualification = /(?<!\p{L})(?:план|планов\p{L}*|прогноз\p{L}*|будущ\p{L}*|ожидаем\p{L}*|устаревш\p{L}*|историческ\p{L}*|архивн\p{L}*|стар\p{L}*\s+оценк\p{L}*|ориентировочн\p{L}*|предварительн\p{L}*|данные\s+уточняются|учебн\p{L}*\s+(?:пример|сценари)\p{L}*|не\s+подтвержд[её]н\p{L}*)(?!\p{L})/iu;
const universityPlacesAllocation = /(?<!\p{L})получил[аи]?\s+\d[\d\s]*\s+мест(?:а|о)?(?!\p{L})/iu;
const calendarYears = /\b(?:19|20|21)\d{2}\b/gu;
const hotelCapacitySubject =
  /^(?:[—–-]\s+)?(?:(?:(?:общая|проектная)\s+)?вместимость(?:\s+(?:первой|второй)\s+очереди)?|(?:первая|вторая)\s+очередь)\s+гостиниц(?!\p{L})/iu;
const hotelCapacityPredicate = /(?<!\p{L})(?:составля\p{L}*|рассчитан\p{L}*)(?!\p{L})/iu;

function hotelCapacityAssertion(quote: string) {
  const match = hotelCapacityStatements.total.exec(quote) ?? hotelCapacityStatements.queue.exec(quote) ??
    hotelCapacityStatements.queueCapacity.exec(quote);
  if (!match?.groups) return undefined;
  const { queue, number, unit, campus } = match.groups;
  const scope: HotelScope = !queue ? "total" : /^перв/iu.test(queue) ? "first" : "second";
  return { scope, number, unit, value: parseNumeric(number), requiresCampusHeading: !campus };
}

function campusProofContext(
  text: string,
  span: StatementSpan,
  campus: CampusCard,
  scope?: HotelScope,
  requiresCampusHeading = false,
  frames = factCheckFrames(text)
): boolean {
  if (text.slice(span.frameStart, span.frameEnd).trim() !== span.quote || namesOtherCampus(span.quote, campus)) return false;
  const explicitCampus = span.quote.match(campusName) !== null;
  let campusResolved = false;
  let includePlainContext = true;
  let sectionDepth = 7;
  let prior = frames.findLastIndex(frame => frame.start < span.frameStart);
  for (let index = prior; index >= 0; index--) {
    const frame = frames[index];
    const line = frame.text.trim();
    const depth = markdownHeading.exec(line)?.[0].trimEnd().length ?? 0;
    if (depth) {
      if (depth >= sectionDepth) continue;
      sectionDepth = depth;
      includePlainContext = false;
    } else if (!includePlainContext) continue;

    // Each capacity or construction assertion carries its own subject, predicate and scope.
    // Its queue or quantity cannot qualify the next sentence simply because they share a line.
    const foreignCampus = namesOtherCampus(line, campus);
    const completeAssertion = sentenceEnd.test(line) && claimVerb.test(line) &&
      !framedCampusDescription.test(line) && !omitsAssertionQualification(line.replace(datedYear, ""), "");
    const unrelatedDatedStatement = completeAssertion && datedYear.test(line) &&
      !domainSubject.test(line) && !campusRelativePeriod.test(line);
    const independentAssertion = foreignCampus
      ? explicitCampus && completeAssertion
      : hotelCapacityAssertion(line) || hotelCapacitySubject.test(line) && hotelCapacityPredicate.test(line) ||
        matchesCampusOpeningAssertion(line, campus) || unrelatedDatedStatement;
    if (!depth && independentAssertion) {
      if (index === prior) prior--;
      continue;
    }

    const heading = depth > 0 || bareCampusHeading.test(line) ||
      !frame.listItem && (!sentenceEnd.test(line) || /\d\s*г\.$/iu.test(line));
    const adjacent = index === prior;
    const unquotedName = (heading || adjacent) ? unquotedCampusLead.exec(line)?.[1] : undefined;
    const campusWords = unquotedName && normalize(unquotedName);
    const knownUnquotedCampus = !!campusWords && /^южный урал(?:\s|$)/u.test(campusWords);
    const namedCampus = line.match(campusName) !== null || knownUnquotedCampus;
    if (heading || namedCampus || adjacent) {
      // Each completed university allocation has its own date. It cannot date the following campus capacity.
      const independentAllocations = !heading && !namedCampus && line.split(contrastSeparator).every(statement =>
        universityPlacesAllocation.test(statement) && universitiesIn(statement).length === 1);
      const context = independentAllocations ? line.replace(calendarYears, "") : line;
      if (omitsAssertionQualification(context, "") || campusContextQualification.test(context) || campusRelativePeriod.test(context)) return false;
      if (heading && !namedCampus && universitiesIn(line).length > 0) return false;
      if (Array.from(line.matchAll(hotelCapacityQueue)).some(([, queue]) => resolveQueue(queue) !== scope)) return false;
    }
    const hotelOwner = heading && hotelHeadingOwner.exec(line)?.[1];
    if (hotelOwner && !/^(?:кампуса(?: южный урал)?|южного урала)$/u.test(normalize(hotelOwner))) return false;
    if (!campusResolved) {
      if (foreignCampus || campusWords && !knownUnquotedCampus) return false;
      if (namedCampus && (!requiresCampusHeading || heading && frame.standalone)) {
        campusResolved = true;
        includePlainContext = false;
      }
    }
  }
  return !requiresCampusHeading || campusResolved;
}

/** Preserve the heading and assertion frame when validating a model-supplied span. */
export function permitsHotelCapacityProof(text: string, span: StatementSpan, campus: CampusCard): boolean {
  if (!/\d/u.test(span.quote) || !/гостини[цч]/iu.test(span.quote) || !/(?<!\p{L})мест[а-яё]*/iu.test(span.quote)) return true;
  const assertion = hotelCapacityAssertion(span.quote);
  return !!assertion && campusProofContext(text, span, campus, assertion.scope, assertion.requiresCampusHeading);
}

export function matchCampusHotelCapacity(text: string, span: StatementSpan, campus: CampusCard, frames?: SentenceFrame[]) {
  const assertion = hotelCapacityAssertion(span.quote);
  if (!assertion || !Number.isSafeInteger(assertion.value) ||
      !campusProofContext(text, span, campus, assertion.scope, assertion.requiresCampusHeading, frames)) return undefined;

  const labels: Record<HotelScope, string[]> = {
    total: ["общая вместимость гостиниц", "вместимость и контингент"],
    first: ["первая очередь гостиниц"],
    second: ["вторая очередь гостиниц"],
  };
  const rows = campus.campusMetrics.map((metric, index) => ({ metric, index }))
    .filter(({ metric }) => labels[assertion.scope].includes(normalize(metric.label)));
  if (rows.length !== 1) return undefined;
  const [{ metric, index }] = rows;
  // Calendar dates can identify a source or occupancy permit without making the metric a plan.
  if (campusMetricQualification.test(metric.note) || campusRelativePeriod.test(metric.note) ||
      omitsAssertionQualification(metric.note.replace(calendarYears, ""), "")) return undefined;
  const places = Array.from(metric.value.trim().matchAll(/(?:^|[,/]\s*)(\d+(?:[ \u00a0\u202f]\d{3})*)\s+мест(?:а|о)?\s*(?=$|[,/](?!\d))/giu));
  const value = places.length === 1 ? parseNumeric(places[0][1]) : Number.NaN;
  if (!Number.isSafeInteger(value)) return undefined;

  const level: "green" | "red" = value === assertion.value ? "green" : "red";
  const last = value % 10;
  const lastTwo = value % 100;
  const unit = (lastTwo > 10 && lastTwo < 20) || last === 0 || last >= 5 ? "мест" : last === 1 ? "место" : "места";
  const numberStart = span.quote.lastIndexOf(assertion.number);
  const unitEnd = span.quote.lastIndexOf(assertion.unit) + assertion.unit.length;
  const replacement = level === "red" ? span.quote.slice(0, numberStart) +
    value.toLocaleString("ru-RU").replace(/\s/gu, " ") + " " + unit + span.quote.slice(unitEnd) : undefined;
  return { metric, value, field: `campusMetrics.${index}`, level, replacement };
}

function unitRoot(value: string): string {
  return normalize(value)
    .split(" ")
    .map((token) => token.slice(0, 5))
    .join(" ");
}

function sameUnit(unit: string, claim: string): boolean {
  const roots = unitRoot(unit).split(" ").filter(Boolean);
  const claimRoots = new Set(unitRoot(claim).split(" "));
  return roots.length > 0 && roots.every((root) => claimRoots.has(root));
}

const universityMetricWords = new Set(
  "в за с к по на год года году факт фактический план фактически получил получила получили выделено выделены предоставлено составляет составило насчитывается было будет будут предусмотрено планирует запланировано".split(
    " "
  )
);

function namesUniversityMetric(
  item: UniversityCard["structuredMetrics"][number],
  claim: string,
  universityId: string
): boolean {
  const words = tokenizeKnowledgeText(claim).filter(
    (word) => !/^\d/u.test(word)
  );
  const label = tokenizeKnowledgeText(item.label);
  const unit = tokenizeKnowledgeText(item.unit);
  const names = tokenizeKnowledgeText(
    getUniversityName(universityId) + " " + getUniversityFullName(universityId)
  );
  const inSet = (word: string, values: string[]) =>
    values.some((value) => sameKnowledgeWord(word, value));
  const quota =
    label.includes("квота") &&
    words.some((word) =>
      /^(?:получил[аи]?|выделен[оы]?|предоставлено|планирует)$/u.test(word)
    );
  const labelDefined = label.every(
    (word) =>
      inSet(word, unit) || inSet(word, words) || (quota && word === "квота")
  );
  return (
    labelDefined &&
    words.every(
      (word) =>
        universityMetricWords.has(word) ||
        inSet(word, names) ||
        inSet(word, label) ||
        inSet(word, unit) ||
        (quota && sameKnowledgeWord(word, "кампус"))
    )
  );
}

type FindingInput = Omit<FactCheckFinding, "id" | "checkpointLabel">;

function normalizeQuoteForCompare(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function createFinding(input: FindingInput): FactCheckFinding {
  return {
    ...input,
    id: `${input.checkpoint}-${input.sourceCardId}-${input.level}-${input.title}-${normalizeQuoteForCompare(input.quote).slice(0, 48)}`,
    checkpointLabel: FACT_CHECK_CHECKPOINTS[input.checkpoint],
  };
}

function buildSummary(findings: FactCheckFinding[]): FactCheckSummary {
  return {
    red: findings.filter((finding) => finding.level === "red").length,
    yellow: findings.filter((finding) => finding.level === "yellow").length,
    green: findings.filter((finding) => finding.level === "green").length,
    total: findings.length,
  };
}

function buildCheckpointSummaries(
  findings: FactCheckFinding[]
): FactCheckCheckpointSummary[] {
  return (Object.keys(FACT_CHECK_CHECKPOINTS) as FactCheckCheckpoint[]).map(
    (key) => {
      const scoped = findings.filter((finding) => finding.checkpoint === key);

      return {
        key,
        label: FACT_CHECK_CHECKPOINTS[key],
        red: scoped.filter((finding) => finding.level === "red").length,
        yellow: scoped.filter((finding) => finding.level === "yellow").length,
        green: scoped.filter((finding) => finding.level === "green").length,
      };
    }
  );
}

function evidenceKey(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/\[[a-z0-9._-]+\]/giu, "")
    .replace(/[«»„“”"]/gu, "")
    .replace(/\s[—–]\s/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.;:!]+$/u, "")
    .trim();
}

type OfficialField = "head" | "partner" | "title" | "organization";
type OfficialClaim = {
  field: OfficialField;
  predicate: string;
  value: string;
  subject?: string;
  negated?: boolean;
};

const position =
  /(?:(?:заместител[а-яё]*|исполняющ[а-яё]*\s+обязанности)\s+)?(?:руководител[а-яё]*|заведующ[а-яё]*|директор[а-яё]*)/i;
const partnerRole =
  /(?:(?:индустриальн[а-яё]*|промышленн[а-яё]*|будущ[а-яё]*|планируем[а-яё]*|действующ[а-яё]*|бывш[а-яё]*|прежн[а-яё]*|предыдущ[а-яё]*)\s+){0,2}партн[её]р[а-яё]*/i;
const titleRole =
  /(?:(?:официальн[а-яё]*|полн[а-яё]*|кратк[а-яё]*)\s+)?(?:название|наименование)/i;
const organizationRole =
  /(?:техническ[а-яё]*\s+заказчик[а-яё]*|финансов[а-яё]*\s+партн[её]р[а-яё]*|концессионер[а-яё]*|оператор[а-яё]*|инвестор[а-яё]*|кредитор[а-яё]*)/i;
const officialRoles = [
  { field: "head", pattern: position },
  { field: "partner", pattern: partnerRole },
  { field: "title", pattern: titleRole },
  { field: "organization", pattern: organizationRole },
] satisfies Array<{ field: OfficialField; pattern: RegExp }>;
const namedRelation = new RegExp(
  "^(?<predicate>" +
    officialRoles.map(({ pattern }) => pattern.source).join("|") +
    ")(?:\\s+(?<subject>.+?))?(?:\\s*:\\s*|\\s+[—–-]\\s+|\\s+(?<negated>не\\s+)?(?:является|выступает)\\s+)(?<value>\\S.*)$",
  "iu"
);
const reversedRelation = new RegExp(
  "^(?<value>.+?)(?:\\s+[—–-]\\s+|\\s+(?<negated>не\\s+)?является\\s+|\\s+(?<denial>не)\\s+)" +
    "(?<predicate>" +
    [position, partnerRole, organizationRole]
      .map(({ source }) => source)
      .join("|") +
    ")(?:\\s+(?<subject>.+))?$",
  "iu"
);
const unconfirmedField =
  /(?:^\s*(?:н\/д|нет|[-—–]|уточняется)\s*$|(?:^|\s)не\s+(?:установ|подтвержд|извест|уточн[её]н|указан|определ[её]н)|нет\s+(?:сведений|данных))/iu;
const personName =
  /^(?:[А-ЯЁA-Z]\.|[А-ЯЁA-Z][\p{L}’'-]{1,38})(?:\s+(?:[А-ЯЁA-Z]\.|[А-ЯЁA-Z][\p{L}’'-]{1,38})){1,3}$/u;

const roleDefinitions = officialRoles.map(({ field, pattern }) => ({
  field,
  pattern: new RegExp("^(?:" + pattern.source + ")$", "iu"),
}));
function officialField(predicate: string): OfficialField | undefined {
  return roleDefinitions.find(({ pattern }) => pattern.test(predicate))?.field;
}

function namedClaim(pattern: RegExp, text: string): OfficialClaim | undefined {
  const groups = pattern.exec(text)?.groups;
  const field = groups && officialField(groups.predicate);
  if (field && groups) {
    const deniedValue = /^не\s+(?!только(?:\s|$))(.+)$/iu.exec(groups.value);
    return {
      field,
      predicate: groups.predicate,
      subject: groups.subject,
      value: deniedValue?.[1] ?? groups.value,
      negated: Boolean(groups.negated || groups.denial || deniedValue),
    };
  }
}

function officialClaims(statement: string): OfficialClaim[] {
  if (statement.length > 500) return [];
  const text = statement
    .replace(referenceLead, "")
    .replace(/[.;:!?]+$/u, "")
    .trim();
  const named =
    namedClaim(namedRelation, text) ?? namedClaim(reversedRelation, text);
  if (named) return [named];
  const head =
    /^(.+?)\s+(не\s+)?(руководит|возглавляет|заведует)\s+(.+)$/iu.exec(text);
  if (head) {
    const [, first, negated, predicate, last] = head;
    return [
      {
        field: "head",
        predicate,
        value: last,
        subject: first,
        negated: Boolean(negated),
      },
      {
        field: "head",
        predicate,
        value: first,
        subject: last,
        negated: Boolean(negated),
      },
    ];
  }
  const partner =
    /^(.+?)\s+(не\s+)?(?:работает|сотрудничает)\s+с\s+(партн[её]ром)\s+(.+)$/iu.exec(
      text
    );
  if (partner) {
    const [, subject, negated, predicate, value] = partner;
    return [
      {
        field: "partner",
        predicate,
        value,
        subject,
        negated: Boolean(negated),
      },
    ];
  }
  const inline = /^([^:]{1,180})\s*:\s*(.+)$/u.exec(text);
  if (inline) {
    const first = namedClaim(namedRelation, inline[2]);
    if (first && !first.subject) return [{ ...first, subject: inline[1] }];
  }
  return [];
}

function equivalentWords(first: string, second: string): boolean {
  const left = tokenizeKnowledgeText(first);
  const right = tokenizeKnowledgeText(second);
  return (
    left.length === right.length &&
    left.length > 0 &&
    left.every((word, index) => sameKnowledgeWord(word, right[index]))
  );
}

function scopeAliases(card: KnowledgeCard): string[] {
  const names = [card.title, projectTitle(card), card.id];
  if (card.type === "university") {
    names.push(
      getUniversityName(card.universityId),
      getUniversityFullName(card.universityId)
    );
  } else if (card.type === "campus") {
    names.push("кампус", "кампус Южный Урал");
  }
  return names;
}

/** Only a complete subject can bind an official role. A title in a nearby clause is insufficient. */
function officialScope(
  subject: string,
  cards: KnowledgeCard[],
  heading = false
): KnowledgeCard | undefined {
  const names = [subject];
  if (!heading) {
    names.push(
      subject.replace(
        /^(?:проект[а-яё]*|вуз[а-яё]*|университет[а-яё]*)\s+(?=[«"„“]|[А-ЯЁ\d])/u,
        ""
      )
    );
  }
  const matches = cards.filter((card) =>
    scopeAliases(card).some((alias) =>
      names.some(
        (name) =>
          normalize(name) === normalize(alias) ||
          (!heading && equivalentWords(name, alias))
      )
    )
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function positionKind(predicate: string) {
  if (/заместител/iu.test(predicate)) return "deputy";
  if (/исполняющ/iu.test(predicate)) return "acting";
  if (/заведу/iu.test(predicate)) return "chair";
  if (/директор/iu.test(predicate)) return "director";
  return "leader";
}

function headComparison(
  claim: OfficialClaim,
  lab: LaboratoryCard
): FactCheckLevel {
  const [name, detail = ""] = lab.head.trim().split(/\s*[,—]\s*/, 2);
  if (!name || unconfirmedField.test(lab.head)) return "yellow";
  const matchesName = normalize(claim.value) === normalize(name);
  if (!matchesName)
    return personName.test(claim.value) &&
      personName.test(name) &&
      !claim.negated
      ? "red"
      : "yellow";
  const requested = positionKind(claim.predicate);
  const actual = positionKind(detail);
  if (requested === "leader" && actual === "deputy") return "yellow";
  if (requested !== "leader" && actual === "leader") return "yellow";
  if (requested !== "leader" && requested !== actual)
    return claim.negated ? "yellow" : "red";
  return claim.negated ? "red" : "green";
}

const legalForm = /^(?:ооо|оао|зао|пао|ао|ано|нпо|гауз|гку|фгбу|гау|гбу)\s+/u;
function partnerPeriod(text: string) {
  const period =
    /(?<![\p{L}])(будущ|планируем|бывш|прежн|предыдущ)[а-яё]*\s+(?:(?:индустриальн|промышленн)[а-яё]*\s+)?партн[её]р/iu
      .exec(text)?.[1]
      .toLowerCase();
  if (!period) return "current";
  return period === "будущ" || period === "планируем" ? "future" : "past";
}

function organizationKey(text: string): string {
  return normalize(text).replace(/^компания\s+/u, "");
}

function organizationParts(value: string): string[] {
  // Quoted names can contain conjunctions and commas. Provenance outside the
  // quoted name does not form part of an entity's official name.
  const quoted = /[«"][^»"]*[»"]/gu;
  return value
    .replace(quoted, (name) =>
      name.replace(/[,/]/gu, "\u0001").replace(/\s+и\s+/giu, "\u0002")
    )
    .split(/\s+(?:и|\/)\s+|,\s+(?!\d)/iu)
    .map((piece) =>
      piece.replaceAll("\u0001", ",").replaceAll("\u0002", " и ").trim()
    );
}

const organizationAttribution =
  /\s+(?:по\s+(?:сообщени|сведени|публикаци|данным)|назван[а-яё]*\s+(?:будущ|планируем|бывш|прежн|предыдущ)|в\s+анонс)/iu;
const exactOrganizationSpelling =
  /^(?:(?:[А-ЯЁA-Z]{2,8}|[Кк]омпания)\s+)?(?:«[^»]+»|"[^"]+"|[А-ЯЁA-Z][\p{L}\p{N}.'’-]*(?:\s+[А-ЯЁA-Z][\p{L}\p{N}.'’-]*){0,4})$/u;

function companyMatches(claimed: string, source: string): boolean {
  return (
    claimed === source ||
    (!legalForm.test(claimed) && claimed === source.replace(legalForm, ""))
  );
}

function companyComparison(
  claim: OfficialClaim,
  expected: string
): FactCheckLevel {
  if (unconfirmedField.test(expected)) return "yellow";
  if (
    claim.field === "partner" &&
    partnerPeriod(expected) !== partnerPeriod(claim.predicate)
  )
    return "yellow";
  if (evidenceKey(claim.value) === evidenceKey(expected)) {
    return claim.negated ? "red" : "green";
  }
  const sourceLabel =
    /^(?:будущ|планируем|бывш|прежн|предыдущ)[а-яё]*\s+партн[её]р[а-яё]*\s*:\s*/iu;
  const sourceParts = organizationParts(expected.replace(sourceLabel, "")).map(
    (piece) => piece.split(organizationAttribution, 1)[0]
  );
  const sourceNames = sourceParts.map(organizationKey).filter(Boolean);
  const claimedParts = organizationParts(claim.value);
  const claimedNames = claimedParts.map(organizationKey).filter(Boolean);
  if (
    !sourceNames.length ||
    !claimedNames.length ||
    claim.value.length > 140 ||
    organizationAttribution.test(claim.value) ||
    !claimedParts.length ||
    claimedParts.some((piece) => !piece) ||
    /(?<![\p{L}])(?:не|только|новый|бывший|между)(?![\p{L}])/iu.test(
      claim.value
    )
  )
    return "yellow";
  const equal = claimedNames.every((name) =>
    sourceNames.some((source) => companyMatches(name, source))
  );
  if (equal) return claim.negated ? "red" : "green";
  // A generic description of a partner category cannot contradict a named company.
  return !claim.negated &&
    claimedParts.every((piece) => exactOrganizationSpelling.test(piece)) &&
    sourceParts.every((piece) => exactOrganizationSpelling.test(piece.trim()))
    ? "red"
    : "yellow";
}

function canonicalOfficialField(
  claim: OfficialClaim,
  card: KnowledgeCard
): string | undefined {
  switch (claim.field) {
    case "head":
      return card.type === "laboratory" ? card.head : undefined;
    case "partner":
      return card.type === "laboratory"
        ? card.partner
        : card.type === "project"
          ? card.industrialPartner
          : undefined;
    case "title":
      if (card.type === "university")
        return /кратк/iu.test(claim.predicate)
          ? getUniversityName(card.universityId)
          : getUniversityFullName(card.universityId);
      if (card.type === "project" || card.type === "laboratory")
        return projectTitle(card);
      return undefined;
    case "organization": {
      if (card.type !== "campus") return undefined;
      const role = organizationRole.exec(claim.predicate)?.[0];
      const roles = card.legalEntities.filter(
        (item) =>
          role &&
          [
            ...item.role.matchAll(new RegExp(organizationRole.source, "giu")),
          ].some(([value]) => equivalentWords(value, role))
      );
      return roles.length === 1 ? roles[0].name : undefined;
    }
  }
}

function officialComparison(
  claim: OfficialClaim,
  card: KnowledgeCard,
  expected: string
): FactCheckLevel {
  if (!expected) return "yellow";
  if (claim.field === "head" && card.type === "laboratory") {
    return headComparison(claim, card);
  }
  if (claim.field === "title") {
    const same = normalize(claim.value) === normalize(expected);
    if (same) return claim.negated ? "red" : "green";
    return claim.negated ? "yellow" : "red";
  }
  return companyComparison(claim, expected);
}

const attributeValue = /^[^:\n]{1,150}(?::\s*|\s+[—–]\s+)\S/u;
const standaloneOfficialTitle =
  /(?:^|\s)(?:руководит|руководят|возглавляет|возглавляют|заведует|заведуют)(?![\p{L}])/iu;

type DraftStatement = { text: string; standalone: boolean; quoteStart: number; placementQualification: boolean };

function collectOfficialFindings(
  statements: DraftStatement[],
  cards: KnowledgeCard[]
) {
  const findings: FactCheckFinding[] = [];
  const headings: (KnowledgeCard | undefined)[] = [];
  const unbound = new Set<number>();
  const checkedStatements = new Set<number>();
  const scopeCache = new Map<string, KnowledgeCard | undefined>();
  const resolve = (text: string, heading: boolean) => {
    const key = heading + ":" + text;
    if (!scopeCache.has(key))
      scopeCache.set(key, officialScope(text, cards, heading));
    return scopeCache.get(key);
  };
  let heading: KnowledgeCard | undefined;
  for (const [index, { text: statement, standalone, quoteStart }] of statements.entries()) {
    if (statement.endsWith("?")) {
      headings.push(undefined);
      heading = undefined;
      continue;
    }
    const namedHeading = standalone ? resolve(statement, true) : undefined;
    if (namedHeading) {
      heading = namedHeading;
      headings.push(undefined);
      findings.push(
        createFinding({
          level: "green",
          checkpoint: "names",
          title: "Название совпадает с утверждённой карточкой",
          quote: statement,
          quoteStart,
          explanation: "В тексте указано имя сущности из утверждённой базы.",
          suggestion: "Сохраните ссылку на официальную карточку.",
          ...sourceFromCard(namedHeading),
        })
      );
      checkedStatements.add(index);
      continue;
    }
    const claims = officialClaims(statement);
    const checked = claims.flatMap((claim) => {
      const card = claim.subject ? resolve(claim.subject, false) : heading;
      const expected = card && canonicalOfficialField(claim, card);
      return card && expected !== undefined ? [{ claim, card, expected }] : [];
    });
    if (checked.length === 1) {
      const { claim, card, expected } = checked[0];
      const level = officialComparison(claim, card, expected);
      findings.push(
        createFinding({
          level,
          checkpoint: "names",
          title:
            level === "green"
              ? "Сведения совпадают с официальной карточкой"
              : level === "red"
                ? "Сведения не совпадают с официальной карточкой"
                : "Утверждение требует подтверждения",
          quote: statement,
          quoteStart,
          explanation:
            level === "yellow"
              ? "В утверждённой карточке этой сущности нет достаточных сведений для такой формулировки."
              : "В утверждённой карточке этой сущности указано: " + expected,
          suggestion:
            level === "red"
              ? "Используйте сведения из утверждённой карточки именно этой сущности."
              : level === "green"
                ? "Сохраните ссылку на официальную карточку."
                : "Уточните связь, имя или должность по официальному источнику.",
          ...sourceFromCard(card),
        })
      );
      checkedStatements.add(index);
    } else if (claims.some((claim) => !claim.subject)) {
      unbound.add(index);
    }
    const attribute = attributeValue.test(statement);
    headings.push(attribute ? heading : undefined);
    if (!attribute) heading = undefined;
  }
  return { findings, headings, unbound, checkedStatements };
}

function cardEvidenceStatements(card: KnowledgeCard, split = true): string[] {
  const text = [card.title, projectTitle(card), card.referenceDescription];
  if (card.type === "project") {
    text.push(
      ...card.confirmedFigures,
      ...card.confirmedFigures.map((figure) => card.title + ": " + figure),
      card.sphere,
      "Инициатор: " + getUniversityName(card.initiatorUniversityId),
      "Участники: " +
        [
          ...new Set(
            card.isJoint
              ? card.participantUniversityIds.map(getUniversityName)
              : [
                  getUniversityName(card.initiatorUniversityId),
                  ...card.coExecutors,
                ]
          ),
        ].join(", "),
      "Индустриальный партнёр: " + card.industrialPartner,
      "Контур: " + card.contour,
      "Стадия готовности: " + card.readinessStage
    );
  } else if (card.type === "laboratory") {
    text.push(
      placementStatusLabels[card.placementStatus],
      card.placementDetails,
      ...card.confirmedIndicators,
      ...card.workDirections,
      ...card.equipment
    );
  } else if (card.type === "campus") {
    text.push(
      ...card.campusMetrics.flatMap((item) => [
        item.label + ": " + item.value,
        item.note,
      ])
    );
    text.push(
      ...card.legalEntities.map((item) => item.name + " — " + item.role)
    );
    text.push(...card.tariffs.map((item) => item.label + " — " + item.value));
  }
  return split ? [...text, ...text.flatMap(factCheckStatements)] : text;
}

const claimVerb =
  /(?<![\p{L}])(?:\p{L}{3,}(?:ается|яется|уются|иваются|ются|ется|ится|ают|яют|уют|яет|ает|или|али|ели|яла|ила|ала|овал[аи]?|ил[аи]?|ён[аыо]|ен[аыо])|создал[аи]?|получил[аи]?|стал[аи]?|был[аио]?|есть)(?![\p{L}])/iu;
const referenceLead =
  /^(?:по данным|согласно) (?:официальной |утвержденной )?карточк[а-я]*\s*[,—:]?\s*/iu;
const editorialLead =
  /^(?:кроме того|помимо этого|далее|затем|наконец|при этом|в частности|например|таким образом)\s*[,;:]\s*/iu;
const neutralQuestionHeading =
  /^(?:кто\s+участвует(?:\s+в\s+проекте)?|что\s+это(?:\s+(?:такое|означает))?|что\s+дальше|что\s+известно(?:\s+о\s+проекте)?|как\s+это\s+работает|зачем\s+это\s+нужно|где\s+найти\s+источники|где\s+отрабатывают\s+технологию)\s*[?]?$/iu;
const neutralTransition =
  /^(?:сначала|далее|теперь)\s+(?:разбер[её]мся|посмотрим|рассмотрим),\s+(?:как\s+это\s+работает|что\s+это\s+означает)\s*[.!?]?$/iu;
const navigationLead =
  /^(?:(?:(?:а|и)\s+)?(?:сначала|далее|дальше|теперь|затем|после\s+этого|в\s+заключение)|перейд[её]м|верн[её]мся|обратимся)[\s,—–:-]+/iu;
const navigationTopic =
  /^(?:к\s+(?:главному|итогам|выводам|контексту|деталям|подробностям|следующему\s+разделу)|(?:о|об|про)\s+(?:главном|сути|деталях|подробностях|итогах|выводах|контексте))\s*[.!?]?$/iu;
const questionLead =
  /^(?:кто|что|где|когда|как(?:ой|ая|ое|ие|ого|ому|ую|их|им|ими)?|зачем|почему|в\s+ч[её]м|сколько)(?![\p{L}])/iu;
const editorialDirective = /^(?:нельзя|не следует|запрещено)(?![\p{L}])/iu;
const domainSubject =
  /(?<!\p{L})(?:кампус\p{L}*|вуз(?:а|у|е|ом|ы|ов|ами|ах)?|унк|пиш|умноц|лаборатор\p{L}*|робот(?:а|у|е|ом|ы|ов|ами|ах)?|тренаж[её]р\p{L}*)(?!\p{L})/iu;
const officeTitle = /^(?:ректор|проректор)(?!\p{L})/iu;
const possessiveArea = /^(?:его|е[ёе]|их)\s+(?:общая\s+)?площад\p{L}*/iu;
const datedYear = /(?:в|к|до|после)\s+(?:19|20|21)\d{2}\s*(?:г\.|год\p{L}*)/iu;
const hotelAccommodationClaim = /гостини[цч].*могут\s+проживать\s+\d/iu;
const framedCampusDescription = /(?:гипотез|гипотетическ|учебный\s+(?:пример|сценарий)|недостоверн|опроверг|ошибочн|неверн|это\s+не\s+так)/iu;

function matchesCampusOpeningAssertion(quote: string, campus: CampusCard): boolean {
  const opening = campus.referenceDescription.trim().split(/\r?\n[ \t]*\r?\n/u, 1)[0];
  quote = quote.replace(speechMarker, "");
  const subject = /^(?:межуниверситетский\s+)?кампус\s+[«"„“]([^»"“”]+)[»"“”]\s+/iu.exec(quote);
  return !!subject && (` ${normalize(campus.title)} `).includes(` ${normalize(subject[1])} `) &&
    (concreteClaimForm(quote) || claimVerb.test(quote)) &&
    evidenceKey(factCheckSentenceRanges(opening)[0]?.text ?? "") === evidenceKey(quote);
}

/** An opening assertion can stand alone only when it names the campus and keeps the source context. */
export function hasExactCampusAssertion(text: string, span: StatementSpan, campus: CampusCard, frames?: SentenceFrame[]): boolean {
  return matchesCampusOpeningAssertion(span.quote, campus) &&
    !framedCampusDescription.test(campus.referenceDescription) && !omitsAssertionQualification(span.quote, "") &&
    campusProofContext(text, span, campus, undefined, false, frames);
}

function factRelevantSpans(draft: string, cards: KnowledgeCard[], frames = factCheckFrames(draft)) {
  const aliases = cards.flatMap(card => scopeAliases(card)
    .map(normalize).filter(name => name.length >= 4)).sort((a, b) => b.length - a.length);
  const exactFacts = new Set(cards.flatMap(card => cardEvidenceStatements(card).map(evidenceKey)));
  const models = recordedEquipmentModels(cards);
  const spans = spansFromFrames(draft, frames);
  let previousRelevant = false;
  let previousEnd = 0;
  let previousQuote = "";
  return spans.map(span => {
    const text = span.quote;
    if (/\r?\n[ \t]*\r?\n/u.test(draft.slice(previousEnd, span.quoteStart))) previousRelevant = false;
    previousEnd = span.quoteEnd;
    const form = nonFactualForm(text);
    const normalized = normalize(text);
    const namedPrefix = aliases.find(alias => normalized === alias || normalized.startsWith(alias + " "));
    const remainder = namedPrefix && normalized.slice(namedPrefix.length).trim();
    const attributedClaim = !!remainder && !nonFactualForm(remainder);
    const explicit = domainSubject.test(text) || universitiesIn(text).length > 0 ||
      aliases.some(alias => (" " + normalized + " ").includes(" " + alias + " ")) ||
      namedEquipmentMentions(text, models).length > 0 || hotelAccommodationClaim.test(text) || !!hotelCapacityAssertion(text);
    const exact = exactFacts.has(evidenceKey(text));
    const contextual = previousRelevant && (
      previousSubject.test(text) || possessiveArea.test(text) || attributeValue.test(text) || standaloneOfficialTitle.test(text) ||
      officialClaims(text).length > 0 ||
      /^(?:в\s+\d{4}|здесь|при\s+открытии|прототип|практическая\s+польза|(?:и\s+)?академическ\p{L}*\s+экспедици\p{L}*|экспедици\p{L}*)\s/iu.test(text) ||
      questionLead.test(text.replace(/^#{1,6}\s+/u, ""))
    );
    const relevant = !form && (exact || explicit || contextual ||
      officialClaims(text).some(claim => !claim.subject));
    const antecedent = previousRelevant && possessiveArea.test(text) ? previousQuote : undefined;
    if (relevant || !form) previousRelevant = relevant;
    previousQuote = text;
    return { ...span, relevant, antecedent, attributedClaim, verdict: form ?? (relevant ? "unknown" : "outside") as FactClaim["verdict"] };
  });
}

export function isRelevantFactFragment(text: string, cards: KnowledgeCard[]): boolean {
  const approved = cards.flatMap(card => {
    const version = getApprovedVersion(card);
    return version ? [version] : [];
  });
  return factRelevantSpans(text, approved).some(span => span.relevant);
}

const pastActionLead = /^(?:уже\s+)?(?:не\s+)?\p{L}{2,}[аеёиуя]л[аои]?\s+/iu;

/** Flag a relationship described as a past action for further review. */
export function hasNamedPastActionRelation(subject: string, predicate: string, cards: KnowledgeCard[]): boolean {
  if (!pastActionLead.test(predicate)) return false;
  const approved = cards.map(getApprovedVersion).filter((card): card is KnowledgeCard => card !== null);
  const approvedUniversities = new Set(approved.map(card => card.type === "university"
    ? card.universityId : getUniversityIdFromFolder(card.folderId)));
  const models = recordedEquipmentModels(approved);
  const knownEquipment = (text: string) => namedEquipmentMentions(text, models)
    .filter(mention => models.includes(mention.model.toLowerCase()));
  const subjectUniversities = universitiesIn(subject);
  const subjectEquipment = knownEquipment(subject);
  const namedEquipmentSubject = subjectEquipment.some(mention =>
    normalize(subject) === normalize([mention.kind, mention.model, mention.variant].join(" ")));
  const subjectCard = officialScope(subject, approved);
  if (!subjectCard && !namedEquipmentSubject && !subjectUniversities.some(id => approvedUniversities.has(id) &&
    [getUniversityName(id), getUniversityFullName(id)].some(name => equivalentWords(subject, name)))) return false;

  if (universitiesIn(predicate).some(id => approvedUniversities.has(id) && !subjectUniversities.includes(id)) ||
      knownEquipment(predicate).some(other => !subjectEquipment.some(mention =>
        mention.model.toLowerCase() === other.model.toLowerCase()))) return true;
  const statement = " " + normalize(predicate) + " ";
  return approved.some(card => card.id !== subjectCard?.id && card.type !== "university" &&
    [card.title, projectTitle(card)].some(alias => {
      const normalized = normalize(alias);
      return normalized.length > 4 && statement.includes(" " + normalized + " ");
    }));
}

function checkableStatement(statement: string, models: string[]): boolean {
  const text = statement.replace(/^#{1,6}\s+/u, "").trim();
  if (neutralQuestionHeading.test(text) || neutralTransition.test(text) ||
      (navigationLead.test(text) && navigationTopic.test(text.replace(navigationLead, "")))) return false;
  if (nonFactualForm(text)) return false;
  if (
    text.endsWith("?") ||
    questionLead.test(text) ||
    attributeValue.test(text) ||
    concreteClaimForm(text)
  ) {
    return true;
  }
  return (
    !editorialDirective.test(text) &&
    (claimVerb.test(text) || standaloneOfficialTitle.test(text) || officeTitle.test(text) ||
      namedEquipmentMentions(text, models).length > 0)
  );
}

function findingSpanKey({ quoteStart, quote }: { quoteStart?: number; quote: string }) {
  return quoteStart === undefined ? "" : quoteStart + ":" + quote.length;
}

function uncoveredStatements(
  input: string,
  statements: ReturnType<typeof factRelevantSpans>,
  cards: KnowledgeCard[],
  covered: Set<string>,
  official: ReturnType<typeof collectOfficialFindings>,
  frames: SentenceFrame[],
  findings: FactCheckFinding[]
): FactCheckFinding[] {
  const models = recordedEquipmentModels(cards);
  const campus = cards.find((card): card is CampusCard => card.type === "campus");
  const coveredOccurrences = new Set(findings.map(findingSpanKey));
  const candidates = statements
    .map((span, index) => ({
      ...span,
      statement: span.quote,
      index,
      hotel: !!campus && !!hotelCapacityAssertion(span.quote),
      opening: !!campus && matchesCampusOpeningAssertion(span.quote, campus),
    }))
    .filter(
      ({ statement, relevant, attributedClaim, index }) =>
        relevant &&
        (attributedClaim || checkableStatement(statement, models) || official.unbound.has(index)) &&
        !official.checkedStatements.has(index)
    ).filter(span => span.hotel || span.opening
      ? !coveredOccurrences.has(findingSpanKey(span))
      : !covered.has(evidenceKey(span.statement).replace(editorialLead, "").replace(referenceLead, ""))
    );
  if (!candidates.length) return [];
  const records = new Map(
    cards.map((card) => [
      card.id,
      cardEvidenceStatements(card).map(evidenceKey),
    ])
  );
  const references = new Set([...records.values()].flat());
  return candidates.flatMap((span) => {
    const { statement, quoteStart, index } = span;
    const scope = official.headings[index];
    const key = evidenceKey(statement).replace(editorialLead, "").replace(referenceLead, "");
    if (
      !span.hotel && !official.unbound.has(index) &&
      (scope ? records.get(scope.id)?.includes(key) : references.has(key)) &&
      (!span.opening || campus && hasExactCampusAssertion(input, span, campus, frames))
    )
      return [];
    return [
      createFinding({
        level: "yellow",
        checkpoint: /\d/u.test(statement) ? "figures" : "names",
        title: "Утверждение требует подтверждения",
        quote: statement,
        quoteStart,
        explanation:
          "Для этого утверждения нужна отдельная опора в утверждённой карточке.",
        suggestion:
          "Найдите подтверждение именно этого утверждения или уточните его у владельца карточки.",
        ...noSource,
      }),
    ];
  });
}

export function checkFactText(
  input: string,
  cards: KnowledgeCard[],
  { keepOccurrences = false }: { keepOccurrences?: boolean } = {}
): FactCheckResult {
  cards = cards
    .map(getApprovedVersion)
    .filter((card): card is KnowledgeCard => card !== null);
  const frames = factCheckFrames(input);
  const spans = factRelevantSpans(input, cards, frames);
  const relevantSpanAt = (index: number) => spans.find(span =>
    span.relevant && span.quoteStart <= index && span.quoteEnd > index
  );
  const relevantQuoteAt = (index: number) => relevantSpanAt(index)?.quote ?? "";
  let previousEnd = 0;
  const draft = spans.filter(span => !span.relevant).map(span => {
    const prefix = input.slice(previousEnd, span.quoteStart);
    previousEnd = span.quoteEnd;
    return prefix + span.quote.replace(/[^\s.!?;,]/gu, value => " ".repeat(value.length));
  }).join("") + input.slice(previousEnd);
  const scopedDraft = maskSoftLineWraps(draft, frames);
  const findings: FactCheckFinding[] = [];
  const confirmedFigures = new Set<string>();
  const checkedHotelSpans = new Set<number>();
  const normalizedDraft = normalize(draft);
  const draftEvidenceKey = evidenceKey(draft);
  const draftRoots = new Set(tokenRoots(draft));
  const exactDescriptionCard = cards.find(
    (card) =>
      draftEvidenceKey.length > 40 &&
      evidenceKey(card.referenceDescription) === draftEvidenceKey
  );
  const referencedCards = cards.filter((card) =>
    isCardReferenced(card, draftRoots, normalizedDraft)
  );

  const campusCard =
    referencedCards.find(
      (card): card is CampusCard => card.type === "campus"
    ) ??
    cards.find((card): card is CampusCard => card.type === "campus") ??
    null;

  const draftStatements = spans.map(({ quote, quoteStart, quoteEnd, frameStart, frameEnd, relevant, standalone }) => ({
    text: relevant ? quote : "",
    standalone,
    quoteStart,
    placementQualification: omitsAssertionQualification(input.slice(frameStart, quoteStart), input.slice(quoteEnd, frameEnd)),
  }));
  const official = collectOfficialFindings(draftStatements, cards);
  findings.push(...official.findings);
  const projectCards = cards.filter(
    (card): card is ProjectCard => card.type === "project"
  );
  const labCards = cards.filter(
    (card): card is LaboratoryCard => card.type === "laboratory"
  );
  findings.push(...collectScopedFindings(input, draftStatements, projectCards, labCards));

  if (campusCard) {
    const areaRegex = new RegExp(campusAreaMeasurement, "giu");
    let areaMatch: RegExpExecArray | null;
    let previousAreaEnd = 0;
    let previousAreaScope: CampusAreaScope | null = null;

    while ((areaMatch = areaRegex.exec(scopedDraft)) !== null) {
      const preceding = scopedDraft.slice(previousAreaEnd, areaMatch.index);
      previousAreaEnd = areaRegex.lastIndex;
      const restatementScope: CampusAreaScope | null =
        /^\s*\(\s*$/u.test(preceding) && /^\s*\)/u.test(scopedDraft.slice(previousAreaEnd))
        ? previousAreaScope
        : null;
      previousAreaScope = null;
      const sentence = sentenceAt(scopedDraft, areaMatch.index);
      const measure = input.slice(areaMatch.index, previousAreaEnd).trim();
      const areaSpan = relevantSpanAt(areaMatch.index);
      const quote = areaSpan?.quote ?? "";
      const antecedent = areaSpan?.antecedent ?? "";
      const refersToCampus = /кампус/iu.test(antecedent) &&
        !universitiesIn(antecedent).length && !namesOtherCampus(antecedent, campusCard);

      if (!quote || areaSpan && omitsAssertionQualification(
          input.slice(areaSpan.frameStart, areaSpan.quoteStart), input.slice(areaSpan.quoteEnd, areaSpan.frameEnd)
        ) || (!refersToCampus && !isCampusClaim(scopedDraft, areaMatch.index)) ||
          namesOtherCampus(sentence, campusCard) || datedYear.test(quote) || campusMetricQualification.test(quote) ||
          /(?:историческ\p{L}*|в\s+прошлом|раньше|бывш\p{L}*|составлял\p{L}*|планиру\p{L}*|будет|предполага\p{L}*|якобы|не\s+(?:составля\p{L}*|равн\p{L}*))/iu.test(quote) ||
          questionLead.test(sentence)) continue;

      const value = parseAreaNumber(areaMatch[1] ?? "");
      const multiplier = areaMatch[3] ? 1000 : 1;
      const multiplied = value * multiplier;
      const multipliedHigh = areaMatch[2] ? parseAreaNumber(areaMatch[2]) * multiplier : multiplied;

      if (!Number.isFinite(multiplied) || !Number.isFinite(multipliedHigh) || multipliedHigh < multiplied) continue;

      // The next metric in the same sentence cannot label this number.
      const prefix = claimClause(preceding, preceding.length);
      const before: CampusAreaScope | null = campusAreaScope(prefix) ?? restatementScope;
      const tail: string = before ? "" : claimClause(scopedDraft.slice(previousAreaEnd), 0);
      const scope: CampusAreaScope | null = before ??
        (tail && !campusAreaMeasurement.test(tail) ? campusAreaScope(tail) : null) ??
        (/кампус/iu.test(prefix) && !/площад/iu.test(prefix) ? "campus" : null);
      previousAreaScope = scope;
      const evidence = campusAreaEvidence(campusCard, scope);
      const quoteStart = areaSpan?.quoteStart ?? draft.lastIndexOf(quote, areaMatch.index);
      if (!evidence.some(({ low, high }) => multiplied >= low && multipliedHigh <= high)) {
        const officialAreas = [...new Set(evidence.map(({ source }) => source))].join("; ");
        const formattedEvidence = [...new Set(evidence.map(({ low, high }) =>
          low === high ? formatArea(low) : formatArea(low).replace(/ м²$/u, "") + "–" + formatArea(high)
        ))];
        const replacement = formattedEvidence.length === 1 && quote.includes(measure)
          ? quote.replace(measure, formattedEvidence[0])
          : undefined;
        findings.push(
          createFinding({
            level: evidence.length ? "red" : "yellow",
            checkpoint: "campus",
            title: evidence.length ? "Площадь кампуса не совпадает с паспортом" : "Площадь кампуса требует подтверждения",
            quote,
            quoteStart,
            explanation: evidence.length
              ? `Показатель ${formatArea(multiplied)} не совпадает с соответствующей площадью в утверждённой версии паспорта: ${officialAreas}.`
              : "В утверждённом паспорте нет показателя площади для указанного объекта.",
            suggestion: evidence.length
              ? "Уточните значение площади по соответствующему полю паспорта."
              : "Сверьте площадь указанного объекта с актуальным официальным документом.",
            replacement,
            ...sourceFromCard(campusCard),
          })
        );
      } else if (
        /^(?:(?:общая\s+)?площад\p{L}*|(?:жил\p{L}*|учебно[- ]научн\p{L}*)\s+площад\p{L}*)(?!\p{L})/iu.test(quote) &&
        !/[;!?]|,\s+\p{L}/u.test(quote) && !/\s(?:и|котор\p{L}*)\s+/iu.test(quote)
      ) {
        findings.push(createFinding({
          level: "green",
          checkpoint: "campus",
          title: "Площадь подтверждена паспортом",
          quote,
          quoteStart,
          explanation: "Значение соответствует показателю площади для указанного объекта.",
          suggestion: "Сохраните единицу измерения и ссылку на утверждённый паспорт.",
          ...sourceFromCard(campusCard),
        }));
        confirmedFigures.add(evidenceKey(quote));
      }
    }

    const costRegex = /(\d[\d\s.,]*)\s*млрд/gi;
    let costMatch: RegExpExecArray | null;

    while ((costMatch = costRegex.exec(draft)) !== null) {
      const sentence = relevantQuoteAt(costMatch.index);

      if (!sentence || !isCampusClaim(draft, costMatch.index) || namesOtherCampus(sentence, campusCard)) continue;

      const value = parseNumeric(costMatch[1] ?? "");
      const evidence = campusMeasureSources(campusCard, "cost", sentence);

      if (
        Number.isFinite(value) &&
        evidence.length &&
        !isOfficialCampusMeasure(campusCard, "cost", value, sentence)
      ) {
        findings.push(
          createFinding({
            level: "red",
            checkpoint: "campus",
            title:
              "Стоимость или объём финансирования не совпадает с паспортом",
            quote: sentence,
            explanation: "В утверждённом паспорте для той же сметы указано: " + evidence.join("; ") + ".",
            suggestion:
              "Уточните сумму с привязкой к году расчёта и структуре финансирования по паспорту CAMPUS-PASS-001.",
            ...sourceFromCard(campusCard),
          })
        );
      }
    }

    for (const span of spans) {
      const proof = span.relevant && matchCampusHotelCapacity(input, span, campusCard, frames);
      if (!proof) continue;
      checkedHotelSpans.add(span.quoteStart);
      confirmedFigures.add(evidenceKey(span.quote));
      findings.push(createFinding({
        level: proof.level,
        checkpoint: "campus",
        title: proof.level === "green" ? "Вместимость гостиниц подтверждена паспортом" : "Число мест не совпадает с паспортом кампуса",
        quote: span.quote,
        quoteStart: span.quoteStart,
        explanation: `В утверждённом паспорте указано: ${proof.metric.label} — ${proof.metric.value}.`,
        suggestion: proof.level === "green" ? "Сохраните вид показателя и ссылку на официальный паспорт." :
          "Укажите число мест соответствующей очереди или общую вместимость по паспорту.",
        replacement: proof.replacement,
        sourceField: proof.field,
        ...sourceFromCard(campusCard),
      }));
    }

    const queueRegex =
      /(?<![A-Za-zА-Яа-я0-9])(III|II|I|3|2|1|перв[а-яё]*|втор[а-яё]*|трет[а-яё]*)(?:-?[яей])?\s*(?:очеред[а-яё]*|этап[а-яё]*)[^.!?]{0,45}?(\d{4})(?!\d)/gi;
    let queueMatch: RegExpExecArray | null;

    while ((queueMatch = queueRegex.exec(draft)) !== null) {
      const quote = relevantQuoteAt(queueMatch.index);
      if (!quote || !isCampusClaim(draft, queueMatch.index) ||
          namesOtherCampus(quote, campusCard) || !/сда[нл]|ввод|введ[её]|откры|заверш|полн\p{L}*\s+запуск/iu.test(quote)) continue;
      // «3 очереди» / «3 этапа» во множественном числе — это общее количество очередей, а не 3-я очередь
      if (
        /^(?:2|3)\s+(?:очереди|этапа)(?![а-яёa-z0-9])/i.test(queueMatch[0]) ||
        /(?:всего|строительства|разделено\s+на)\s*\(?\s*3\s+(?:очереди|этапа)/i.test(
          sentenceAt(draft, queueMatch.index)
        )
      ) {
        continue;
      }

      const queue = resolveQueue(queueMatch[1] ?? "");
      const year = Number.parseInt(queueMatch[2] ?? "", 10);
      const years = queue ? officialQueueYears(campusCard, queue) : [];

      if (!years.length || !Number.isFinite(year) || years.includes(year)) {
        continue;
      }

      findings.push(
        createFinding({
          level: "red",
          checkpoint: "campus",
          title: "Срок очереди кампуса не совпадает с паспортом",
          quote,
          explanation: `Указанный срок отсутствует у этой очереди в утверждённом паспорте. Подтверждённые годы: ${years.join(", ")}.`,
          suggestion:
            "Уточните очередь, вид срока (строительство/полный запуск) и год по паспорту.",
          ...sourceFromCard(campusCard),
        })
      );
    }

  }

  const figureRegex =
    /(\d[\d\s.,]{0,12})\s+((?:[а-яё]{3,}\s+){0,2})(врач[а-яё]*|человек[а-яё]*|студент[а-яё]*|участник[а-яё]*|пациент[а-яё]*|школ[а-яё]*|наставник[а-яё]*|специалист[а-яё]*|команд[а-яё]*|прототип[а-яё]*|модул[а-яё]*|проект[а-яё]*|мест[а-яё]*|преподавател[а-яё]*|сотрудник[а-яё]*|аспирант[а-яё]*)/gi;
  const seenFigures = new Set<string>();
  let figureMatch: RegExpExecArray | null;

  while ((figureMatch = figureRegex.exec(draft)) !== null) {
    const span = relevantSpanAt(figureMatch.index);
    if (span && checkedHotelSpans.has(span.quoteStart)) continue;
    const rawNumber = figureMatch[1] ?? "";
    const key = `${figureMatch.index}:${rawNumber}`;

    if (seenFigures.has(key)) continue;

    seenFigures.add(key);

    const quote = span && hotelCapacityAssertion(span.quote) ? span.quote : sentenceAt(scopedDraft, figureMatch.index, draft);
    const clause = claimClause(scopedDraft, figureMatch.index, draft);
    const universityId = scopedUniversity(scopedDraft, figureMatch.index);
    const universityIds = universitiesIn(clause);
    const localRoots = new Set(tokenRoots(quote));
    const genericRoots = new Set([
      "вирту",
      "лабор",
      "проек",
      "цифро",
      "центр",
      "платф",
      "систе",
      "техно",
      "промы",
    ]);
    const localCards = cards.filter(
      (card) =>
        (card.type === "project" || card.type === "laboratory") &&
        (termMatches(card.title, localRoots) ||
          card.id === exactDescriptionCard?.id ||
          (referencedCards.some((reference) => reference.id === card.id) &&
            tokenRoots(card.title).some(
              (root) => !genericRoots.has(root) && localRoots.has(root)
            )))
    );
    const universityCard =
      universityId && localCards.length === 0
        ? cards.find(
            (card): card is UniversityCard =>
              card.type === "university" && card.universityId === universityId
          )
        : null;
    const campusScope = campusCard && !namesOtherCampus(quote, campusCard) && (
      isCampusClaim(scopedDraft, figureMatch.index) ||
      (universityIds.length === 0 &&
        Boolean(
          campusCard?.campusMetrics.some((metric) =>
            normalize(clause).includes(normalize(metric.label))
          )
        )));
    const sourceCard =
      localCards.length === 1
        ? localCards[0]
        : localCards.length > 1
          ? null
          : universityIds.length > 0
            ? universityCard
            : campusScope
              ? campusCard
              : null;
    const value = parseNumeric(rawNumber);
    const unit = figureMatch[3] ?? "";
    const years = clause.match(/\b(?:19|20|21)\d{2}\b/g) ?? [];
    const year = years.length === 1 ? Number(years[0]) : null;
    const kind = /план|будет|будут|предстоит|предусмотр|к\s+\d{4}/i.test(clause)
      ? "plan"
      : "actual";

    let sameNumberDifferentClaim = false;
    if (universityCard) {
      const candidates = universityCard.structuredMetrics.filter(
        (metric) =>
          metric.year === year &&
          sameUnit(metric.unit, unit) &&
          namesUniversityMetric(metric, clause, universityCard.universityId)
      );
      const samePeriod = candidates.filter((metric) => metric.kind === kind);
      const metric =
        samePeriod.length === 1
          ? samePeriod[0]
          : candidates.length === 1
            ? candidates[0]
            : null;
      if (metric) {
        const matches = metric.value === value && metric.kind === kind;
        findings.push(
          createFinding({
            level: matches ? "green" : "red",
            checkpoint: "figures",
            title: matches
              ? "Показатель вуза подтверждён"
              : "Показатель вуза противоречит официальной карточке",
            quote: clause,
            explanation: `${getUniversityName(universityCard.universityId)}: ${metric.label} — ${metric.value} ${metric.unit}, ${metric.year}, ${metric.kind === "plan" ? "план" : "факт"}. Проверено ${metric.verifiedAt}; ответственный: ${metric.owner}.`,
            suggestion: matches
              ? "Сохраните год, статус и ссылку на документ."
              : "Уточните число, год и статус факт/план по документу в карточке этого вуза.",
            replacement: !matches && metric.kind === kind && clause.includes(figureMatch[0])
              ? clause.replace(figureMatch[0], figureMatch[0].replace(rawNumber.trim(), String(metric.value).replace(".", ",")))
              : undefined,
            ...sourceFromCard(universityCard),
            sourceUrl: metric.evidenceUrl,
          })
        );
        continue;
      }
    } else if (sourceCard) {
      const sources = cardEvidenceStatements(sourceCard);
      const fullStatement = evidenceKey(quote);
      if (
        exactDescriptionCard?.id === sourceCard.id ||
        sources.some((source) => evidenceKey(source) === fullStatement)
      ) {
        confirmedFigures.add(fullStatement);
        continue;
      }
      if (
        sourceCard.type === "campus" &&
        sameUnit("мест", unit) &&
        isOfficialCampusMeasure(
          sourceCard,
          "places",
          value,
          campusMeasureContext(scopedDraft, figureMatch.index)
        )
      ) {
        // This typed rule covers the magnitude and its scope. The surrounding
        // sentence still needs evidence for any additional statement.
        continue;
      }
      sameNumberDifferentClaim = sources.some((source) =>
        Array.from(source.matchAll(new RegExp(figureRegex.source, "gi"))).some(
          (match) =>
            sameUnit(unit, match[3] ?? "") && parseNumeric(match[1]) === value
        )
      );
      // A direct contradiction already owns this numeric claim.
      if (
        findings.some(
          (finding) =>
            finding.level === "red" &&
            finding.sourceCardId === sourceCard.id &&
            finding.quote === quote
        )
      )
        continue;
    }

    findings.push(
      createFinding({
        level: "yellow",
        checkpoint: "figures",
        title: sameNumberDifferentClaim
          ? "Утверждение требует подтверждения"
          : "Цифра не подтверждена официальными данными",
        quote,
        quoteStart: span?.quote === quote ? span.quoteStart : undefined,
        explanation: sameNumberDifferentClaim
          ? "В карточке встречается такое число. Период, статус или связь с другими сведениями в этой формулировке требуют отдельного подтверждения."
          : "Метрики «" +
            figureMatch[0].trim() +
            "» нет в подтверждённых показателях этой сущности за указанный период. Число из другой карточки не является подтверждением.",
        suggestion: universityIds.length
          ? "Укажите вуз, год и статус факт/план; добавьте показатель с документом в паспорт этого вуза."
          : "Уточните сущность, период и единицу измерения; добавьте официальный источник.",
        ...(sourceCard ? sourceFromCard(sourceCard) : noSource),
      })
    );
  }

  for (const rule of AUDIT_STOP_RULES) {
    // The current approved object determines placement and participants.
    // The archived examples contain specific dates and generic pronouns.
    if (
      rule.category === "placement_status" ||
      rule.category === "coauthorship" ||
      rule.id === "RULE-CONTOUR-PISH-MIXUP"
    )
      continue;
    const checkpoint = AUDIT_CATEGORY_TO_CHECKPOINT[rule.category];
    const targetCard = cards.find((card) => card.id === rule.sourceCardId);
    if (!targetCard) continue;
    if (rule.id === "RULE-245-PRODUCTS-5REGIONS") {
      const numbers = /(?<![\p{L}\p{N}.,])(?:37\s+(?:продуктовых\s+)?программ|245\s+(?:решений|продуктов|направлений))(?![\p{L}\p{N}])/giu;
      const quotes = new Set<string>();
      for (const match of draft.matchAll(numbers)) {
        const quote = claimClause(draft, match.index);
        if (!/^(?:(?:сейчас|на\s+сегодня|на\s+сегодняшний\s+день)\s+)?(?:челябинск\p{L}*\s+)?кампус\s*(?:(?:[«"„“]южный\s+урал[»"“”])\s*)?(?:сформировал|реализует|реализовал|включает|объединяет|насчитывает|созда[её]т)(?!\p{L})/iu.test(quote) ||
            /\b(?:19|20|21)\d{2}\b|(?<!\p{L})(?:раньше|ранее|бывш\p{L}*|планир\p{L}*|будет|будут)(?!\p{L})/iu.test(quote) ||
            (targetCard.type === "campus" && namesOtherCampus(quote, targetCard)) ||
            /(?:пят[а-яё]*\s+(?:пилотн[а-яё]*\s+)?регион|сводн[а-яё]+\s+показател|федеральн[а-яё]+\s+показател)/iu.test(quote) ||
            locallyNegated(quote, quote.indexOf(match[0]))) continue;
        quotes.add(quote);
      }
      const evidence = targetCard.type === "campus" && targetCard.campusMetrics.find(metric =>
        /региональн\p{L}*\s+портфел/iu.test(metric.note) &&
        /(?<!\d)8\s+программ/iu.test(metric.value + " " + metric.note) &&
        /(?<!\d)83[–—-]84\s+(?:продукт|решени)/iu.test(metric.value + " " + metric.note)
      );
      for (const quote of quotes) {
        findings.push(createFinding({
          level: evidence ? "red" : "yellow",
          checkpoint,
          title: `${rule.title} (аудит: кейсы ${rule.caseNumbers.join(", ")})`,
          quote,
          explanation: evidence
            ? "Утверждённый паспорт указывает другой показатель челябинского кампуса. " + evidence.note
            : "В утверждённом паспорте нет опоры для атрибуции этих показателей челябинскому кампусу за указанный период.",
          suggestion: auditSuggestion(rule.id, targetCard, rule.canonicalCorrection),
          ...sourceFromCard(targetCard),
        }));
      }
      continue;
    }
    const match = rule.pattern.exec(draft);
    if (!match || match.index === undefined) continue;
    const matchQuote = relevantQuoteAt(match.index);
    if (!matchQuote) continue;
    if (targetCard.type === "campus" && namesOtherCampus(matchQuote, targetCard)) continue;
    if (rule.id === "RULE-KUKA-TRANSCRIPTION" &&
        scopedEquipmentLab(namedEquipmentMentions(matchQuote, recordedEquipmentModels(labCards)), labCards, matchQuote)?.id !== targetCard.id &&
        uniqueScopedCard(matchQuote, labCards)?.id !== targetCard.id) continue;
    const quoteIndex = matchQuote.indexOf(match[0]);
    if (quoteIndex >= 0 && locallyNegated(matchQuote, quoteIndex)) continue;

    if (rule.id === "RULE-AREA-OUTDATED") {
      const conflict = findings.find(finding => finding.level === "red" &&
        finding.title === "Площадь кампуса не совпадает с паспортом" &&
        finding.sourceCardId === targetCard.id && matchQuote.includes(finding.quote));
      if (conflict) conflict.title += ` (аудит: кейсы ${rule.caseNumbers.join(", ")})`;
      continue;
    }

    const normalizedMatchQuote = normalizeQuoteForCompare(matchQuote);

    // Избегаем дублирования одной и той же ошибки встроенной проверкой и правилом аудита
    const duplicate = findings.find((existing) => {
      if (existing.title.includes("аудит:")) return false;
      if (
        existing.level !== rule.severity ||
        existing.checkpoint !== checkpoint
      ) {
        return false;
      }
      const existingQuote = normalizeQuoteForCompare(existing.quote);
      return (
        existingQuote === normalizedMatchQuote ||
        existingQuote.includes(normalizedMatchQuote) ||
        normalizedMatchQuote.includes(existingQuote)
      );
    });

    if (duplicate) {
      const caseSuffix = `(аудит: кейсы ${rule.caseNumbers.join(", ")})`;
      if (!duplicate.title.includes("аудит:")) {
        duplicate.title = `${duplicate.title} ${caseSuffix}`;
      }
      continue;
    }

    findings.push(
      createFinding({
        level: rule.severity,
        checkpoint,
        title: `${rule.title} (аудит: кейсы ${rule.caseNumbers.join(", ")})`,
        quote: matchQuote,
        explanation: rule.wrongClaimDescription,
        suggestion: auditSuggestion(rule.id, targetCard, rule.canonicalCorrection),
        replacement: rule.id === "RULE-KUKA-TRANSCRIPTION" &&
          /(?<!\p{L})робот\p{L}*\s+куки(?!\p{L})/iu.test(matchQuote)
          ? matchQuote.replace(/(?<=робот\p{L}*\s+)куки(?!\p{L})/iu, "KUKA")
          : undefined,
        ...sourceFromCard(targetCard),
      })
    );
  }

  if (!exactDescriptionCard) {
    for (const finding of findings) {
      if (finding.level !== "green" || finding.checkpoint === "figures" || finding.checkpoint === "placement") {
        confirmedFigures.add(evidenceKey(finding.quote).replace(editorialLead, "").replace(referenceLead, ""));
        for (const statement of factCheckStatements(finding.quote))
          confirmedFigures.add(evidenceKey(statement));
      }
    }
    findings.push(...uncoveredStatements(input, spans, cards, confirmedFigures, official, frames, findings));
  }

  const matchedKeys = new Set(findings.map(finding => evidenceKey(finding.quote)));
  const matchedOccurrences = new Set(findings.map(findingSpanKey));
  const exactFields = new Map(cards.flatMap(card =>
    cardEvidenceStatements(card, false).map(value => [evidenceKey(value), card] as const)
  ));
  for (const span of spans) {
    const key = evidenceKey(span.quote);
    if (!key || !span.relevant || campusCard && hotelCapacityAssertion(span.quote)) continue;
    const opening = campusCard && matchesCampusOpeningAssertion(span.quote, campusCard);
    if (opening ? matchedOccurrences.has(findingSpanKey(span)) : matchedKeys.has(key)) continue;
    const exactCampusAssertion = opening && hasExactCampusAssertion(input, span, campusCard, frames);
    if (opening && !exactCampusAssertion) continue;
    const card = exactCampusAssertion ? campusCard : exactFields.get(key);
    if (!card) continue;
    if (card.type === "campus" && !exactCampusAssertion && !campusProofContext(input, span, card, undefined, false, frames)) continue;
    matchedKeys.add(key);
    matchedOccurrences.add(findingSpanKey(span));
    findings.push(createFinding({
      level: "green",
      checkpoint: "names",
      title: "Фрагмент совпадает с утверждённой карточкой",
      quote: span.quote,
      quoteStart: span.quoteStart,
      explanation: "Формулировка полностью совпадает с утверждённым полем источника.",
      suggestion: "Сохраните ссылку на утверждённую карточку.",
      ...(exactCampusAssertion && { sourceField: "referenceDescription" }),
      ...sourceFromCard(card),
    }));
  }
  if (!findings.some(finding => finding.level === "green")) {
    for (const card of referencedCards) {
      const title = card.type === "campus" ? "кампус «Южный Урал»"
        : card.type === "laboratory" || card.type === "project" ? projectTitle(card) : "";
      if (!title) continue;
      const literal = title.replace(/[.*+?^$\{\}()|[\]\\]/gu, "\\$&");
      const found = new RegExp("(?<![\\p{L}\\p{N}])" + literal + "(?![\\p{L}\\p{N}])", "iu").exec(draft);
      if (!found || (card.type === "campus" && namesOtherCampus(sentenceAt(draft, found.index), card))) continue;
      findings.push(createFinding({
        level: "green",
        checkpoint: "names",
        title: "Название объекта совпадает с карточкой",
        quote: found[0],
        quoteStart: found.index,
        explanation: "В карточке зафиксировано это название объекта.",
        suggestion: "Сохраните ссылку на карточку объекта.",
        ...sourceFromCard(card),
      }));
      break;
    }
  }
  if (exactDescriptionCard && !findings.length) {
    findings.push(createFinding({
      level: "green",
      checkpoint: "names",
      title: "Описание совпадает с официальной карточкой",
      quote: input.trim(),
      explanation: "Текст полностью совпадает с утверждённым описанием карточки.",
      suggestion: "Сохраните ссылку на официальную карточку.",
      ...sourceFromCard(exactDescriptionCard),
    }));
  }

  const anchored = findings.flatMap(finding => {
    const offset = finding.quoteStart ?? draft.indexOf(finding.quote);
    if (offset < 0 || !finding.quote || input.slice(offset, offset + finding.quote.length) !== finding.quote) return [];
    return [{ ...finding, id: finding.id + "-" + offset, quoteStart: offset, quoteEnd: offset + finding.quote.length }];
  });
  const distinct = new Map<string, (typeof anchored)[number]>();
  for (const finding of anchored) {
    const key = [finding.level, finding.checkpoint, finding.sourceCardId, finding.title.replace(/\s+\(аудит: кейсы[^)]*\)$/u, ""),
      normalizeQuoteForCompare(finding.quote), keepOccurrences ? finding.quoteStart : ""].join("\u0000");
    if (!distinct.has(key)) distinct.set(key, finding);
  }
  const deduped = [...distinct.values()];
  const claimsByRange = new Map<string, FactClaim>();
  const verdictOrder = { contradicted: 0, unknown: 1, supported: 2, opinion: 3, outside: 4 };
  const verdicts = { red: "contradicted", yellow: "unknown", green: "supported" } as const;
  for (const finding of deduped) {
    const claim = makeClaim({
      quote: finding.quote,
      quoteStart: finding.quoteStart,
      quoteEnd: finding.quoteEnd,
    }, verdicts[finding.level]);
    const previous = claimsByRange.get(claim.id);
    if (!previous || verdictOrder[claim.verdict] < verdictOrder[previous.verdict])
      claimsByRange.set(claim.id, claim);
  }
  const indexedClaims = [...claimsByRange.values()];
  const coveredQuotes = new Set(indexedClaims.map(claim => evidenceKey(claim.quote)));
  for (const span of spans) {
    if (coveredQuotes.has(evidenceKey(span.quote)) ||
        indexedClaims.some(claim => claim.quoteStart < span.quoteEnd && claim.quoteEnd > span.quoteStart)) continue;
    const claim = makeClaim(span, span.relevant ? "outside" : span.verdict);
    claimsByRange.set(claim.id, claim);
  }
  const claims = [...claimsByRange.values()].sort((a, b) => a.quoteStart - b.quoteStart);

  const levelOrder: Record<FactCheckLevel, number> = {
    red: 0,
    yellow: 1,
    green: 2,
  };

  const sorted = deduped.sort(
    (a, b) => levelOrder[a.level] - levelOrder[b.level]
  );
  const summary = buildSummary(sorted);

  return {
    findings: sorted,
    summary,
    checkpoints: buildCheckpointSummaries(sorted),
    canPublish: summary.red === 0 && summary.yellow === 0 && summary.green > 0,
    coverage: summary.green ? (summary.red || summary.yellow ? "partial" : "confirmed") : "unverified",
    checkedChars: input.trim().length,
    claims,
    claimCoverage: claimCoverage(claims, "limited"),
  };
}

function rewriteSection(
  id: string,
  heading: string,
  fields: string[],
  level: 2 | 3 = 2
): CanonicalRewriteSection {
  return {
    id,
    heading,
    level,
    chunks: fields
      .filter((field) => field.trim())
      .map((content, index) => ({
        id: id + "-" + (index + 1),
        content,
      })),
  };
}

function campusMetricSection(campus: CampusCard) {
  return rewriteSection(
    "campus-metrics",
    "Параметры кампуса",
    campus.campusMetrics.map((metric) =>
      [metric.label + ": " + metric.value, metric.note]
        .filter(Boolean)
        .join("\n")
    )
  );
}

function buildScopedRewrite(
  title: string,
  description: string,
  sections: CanonicalRewriteSection[],
  sourceCards: KnowledgeCard[]
): CanonicalRewrite {
  let lead = "";
  for (const statement of description
    .split(/[\r\n]/u)
    .filter((line) => !/(?:^|\s[—–-]\s)(?:https?:\/\/|www\.)/iu.test(line.trim()))
    .flatMap(factCheckSentenceRanges)
    .map(({ text }) => text.trim())
    .filter(Boolean)) {
    const next = lead ? lead + " " + statement : statement;
    if (next.length > 1_000) break;
    lead = next;
  }
  if (!lead) lead = title;
  const nonemptySections = sections.filter(
    (section) => section.chunks.length > 0
  );
  return renderCanonicalRewrite({
    title,
    lead,
    sections: nonemptySections,
    sourceCardIds: sourceCards.map((card) => card.id),
    sourceCardTitles: sourceCards.map((card) => card.title),
  });
}

export function renderCanonicalRewrite(rewrite: Omit<CanonicalRewrite, "plainText">): CanonicalRewrite {
  return {
    ...rewrite,
    plainText: rewrite.preservedText ?? [
      rewrite.title,
      rewrite.lead,
      ...rewrite.sections.flatMap((section) => [
        section.heading,
        ...section.chunks.map((chunk) => chunk.content),
      ]),
    ].join("\n\n"),
  };
}

function labPlacementSection(lab: LaboratoryCard) {
  return rewriteSection("lab-status", "Площадка и статус лаборатории", [
    lab.title,
    placementStatusLabels[lab.placementStatus],
    lab.placementDetails,
  ]);
}

function buildProjectRewrite(
  project: ProjectCard,
  lab: LaboratoryCard | null,
  campus: CampusCard | null
): CanonicalRewrite {
  const participants = project.isJoint
    ? project.participantUniversityIds.map(getUniversityName)
    : [
        getUniversityName(project.initiatorUniversityId),
        ...project.coExecutors,
      ];
  const sections = [
    rewriteSection("participants", "Вузы и партнёры", [
      project.title,
      "Инициатор: " + getUniversityName(project.initiatorUniversityId),
      "Участники: " + [...new Set(participants)].join(", "),
      project.industrialPartner
        ? "Индустриальный партнёр: " + project.industrialPartner
        : "",
    ]),
    rewriteSection("result", "Стадия и результаты проекта", [
      "Контур: " + project.contour,
      "Стадия готовности: " + project.readinessStage,
      ...project.confirmedFigures.map(
        (figure) => project.title + ": " + figure
      ),
    ]),
    ...(lab ? [labPlacementSection(lab)] : []),
    ...(campus ? [campusMetricSection(campus)] : []),
  ];
  return buildScopedRewrite(
    project.title,
    project.referenceDescription,
    sections,
    [project, ...(lab ? [lab] : []), ...(campus ? [campus] : [])]
  );
}

function buildLabRewrite(
  lab: LaboratoryCard,
  campus: CampusCard | null
): CanonicalRewrite {
  const sections = [
    labPlacementSection(lab),
    rewriteSection(
      "lab-directions",
      "Направления работы и оборудование",
      [...lab.workDirections, ...lab.equipment, ...lab.confirmedIndicators],
      3
    ),
    ...(campus ? [campusMetricSection(campus)] : []),
  ];
  return buildScopedRewrite(lab.title, lab.referenceDescription, sections, [
    lab,
    ...(campus ? [campus] : []),
  ]);
}

function buildCampusRewrite(campus: CampusCard): CanonicalRewrite {
  return buildScopedRewrite(
    campus.title,
    campus.referenceDescription,
    [
      campusMetricSection(campus),
      rewriteSection(
        "campus-entities",
        "Организации и их роли",
        campus.legalEntities.map((entity) => entity.name + " — " + entity.role),
        3
      ),
      rewriteSection(
        "campus-tariffs",
        "Тарифы",
        campus.tariffs.map((item) => item.label + " — " + item.value),
        3
      ),
    ],
    [campus]
  );
}

const typedEquipment =
  /(?<![\p{L}\p{N}])((?:робот[а-яё]*(?:[-‐‑]манипулятор[а-яё]*)?|манипулятор[а-яё]*|контроллер[а-яё]*|стан(?:ок|к[а-яё]*)|принтер[а-яё]*|датчик[а-яё]*|сканер[а-яё]*|тренаж[её]р[а-яё]*|стенд[а-яё]*|микроскоп[а-яё]*))(\s+модел[ьи])?\s+([«"“])?([\p{L}\p{N}][\p{L}\p{N}-]*)[»"”]?((?:[ \t]+[a-z0-9][a-z0-9-]*(?![\p{L}\p{N}-])[»"”]?)*)/giu;
const bareModel =
  /(?<![\p{L}\p{N}-])[\p{L}][\p{L}\p{N}-]{2,}(?![\p{L}\p{N}-])/gu;
const modelVariant =
  /^[»"”]?((?:[ \t]+[a-z0-9][a-z0-9-]*(?![\p{L}\p{N}-])[»"”]?)*)/iu;
const modelName = /(?<![\p{L}\p{N}])[A-Z][A-Za-z\d-]{2,}(?![\p{L}\p{N}])/gu;
const equipmentActivity =
  /(?<!\p{L})(?:действует|работает|установлен[ао]?|применяется|используется)\s+[«"“]?$/iu;
type EquipmentMention = { kind: string; model: string; variant: string };

function recordedEquipmentModels(cards: KnowledgeCard[]) {
  return [...new Set(cards.flatMap((card) => card.type === "laboratory"
    ? card.equipment.flatMap((item) => withoutSourceUrls(item).match(modelName) ?? [])
    : []
  ).map((model) => model.toLowerCase()))];
}

function namedEquipmentMentions(text: string, models: string[]): EquipmentMention[] {
  const input = withoutSourceUrls(text);
  // Capitalization alone also occurs in ordinary project names such as
  // «тренажёр Травмпункта». An unknown Cyrillic model needs an explicit label.
  const typed = [...input.matchAll(typedEquipment)].filter(([, kind, designation, openingQuote, model]) =>
    /[a-z0-9]/iu.test(model) || Boolean(designation || openingQuote) ||
    (/^робот/iu.test(kind) && /^куки$/iu.test(model)) ||
    models.some((known) => sameKnowledgeWord(model.toLowerCase(), known))
  );
  const mentions = typed.map(([, kind, , , model, variant]) => ({ kind, model, variant }));
  for (const match of input.matchAll(bareModel)) {
    const [model] = match;
    if (typed.some((other) => other.index <= match.index &&
        match.index < other.index + other[0].length)) continue;
    const known = models.some((name) => sameKnowledgeWord(model.toLowerCase(), name));
    if (known || (/^[a-z][a-z0-9-]{2,}$/iu.test(model) &&
        equipmentActivity.test(input.slice(Math.max(0, match.index - 50), match.index)))) {
      const variant = modelVariant.exec(input.slice(match.index + model.length))?.[1] ?? "";
      mentions.push({ kind: "", model, variant });
    }
  }
  return mentions;
}

function scopedEquipmentLab(
  mentions: EquipmentMention[],
  labs: LaboratoryCard[],
  statement = ""
): LaboratoryCard | undefined {
  const universities = universitiesIn(statement);
  const matches = mentions.map(({ kind, model, variant }) => {
    const auditedTypo = /^робот/iu.test(kind) && /^куки$/iu.test(model);
    const terms = knowledgeQueryTerms(`${kind} ${auditedTypo ? "KUKA" : model}${variant}`);
    const eligible = labs.filter((lab) =>
      (!auditedTypo || lab.id === "lab-midis-kuka") &&
      (!universities.length || (universities.length === 1 &&
        (getUniversityIdFromFolder(lab.folderId) === universities[0] || universityMentioned(universities[0], lab.affiliation)))) &&
      knowledgeCardMatch(lab, terms, "equipment") > 0
    );
    return eligible.length === 1 ? eligible[0] : undefined;
  });
  const lab = matches[0];
  return lab && matches.every((match) => match?.id === lab.id) ? lab : undefined;
}

function preservedRewrite(draft: string, cards: KnowledgeCard[]): CanonicalRewrite | null {
  const checked = checkFactText(draft, cards, { keepOccurrences: true });
  const quoted = [...draft.matchAll(
    /«[^»]*»|„[^“]*“|“[^”]*”|"[^"\r\n]*"|^[ \t]*(?:>+[ \t]*|[—–-][ \t]+|(?:[Рр]ектор|[Ии]нтервьюер|[Вв]едущий|[Сс]обеседник|[Аа]втор)\s*:[ \t]*)[^\r\n]+|(?<!\p{L})(?:сказал[аи]?|отметил[аи]?|ответил[аи]?|добавил[аи]?)\s*:\s*[^\r\n]+/gmu
  )];
  const heading = draft.trimStart().split(/\r?\n/u, 1)[0];
  if (interviewTopic.test(heading) || /(?<!\p{L})(?:интервью|бесед\p{L}*|диалог\p{L}*)(?!\p{L})/iu.test(heading)) {
    for (const line of draft.matchAll(/^[ \t]*([^:\r\n]{3,100}):[ \t]*[^\r\n]+/gmu)) {
      if (personName.test(line[1].trim())) quoted.push(line);
    }
  }
  const changes: NonNullable<CanonicalRewrite["changes"]> = [];
  const usedCards = new Set<string>();
  let text = draft;
  let beforePreviousEdit = draft.length;
  for (const finding of [...checked.findings].sort((a, b) => (b.quoteStart ?? 0) - (a.quoteStart ?? 0))) {
    const { level, quote, quoteStart, quoteEnd, replacement, sourceCardId } = finding;
    if (!sourceCardId || level === "yellow") continue;
    usedCards.add(sourceCardId);
    if (level !== "red" || quoteStart == null || quoteEnd == null ||
        !replacement || quoteEnd > beforePreviousEdit || text.slice(quoteStart, quoteEnd) !== quote) continue;
    let start = 0;
    while (start < quote.length && quote[start] === replacement[start]) start++;
    let suffix = 0;
    while (suffix < quote.length - start && suffix < replacement.length - start &&
      quote[quote.length - suffix - 1] === replacement[replacement.length - suffix - 1]) suffix++;
    if (quoted.some(match => match.index < quoteEnd - suffix && match.index + match[0].length > quoteStart + start)) continue;
    text = text.slice(0, quoteStart) + replacement + text.slice(quoteEnd);
    changes.unshift({ before: quote, after: replacement, sourceCardId });
    beforePreviousEdit = quoteStart;
  }
  if (!usedCards.size) return null;
  const sources = cards.filter(card => usedCards.has(card.id));
  const [title, ...body] = text.split(/\r?\n/u);
  return renderCanonicalRewrite({
    title: body.length ? title : "",
    lead: body.length ? body.join("\n").trim() : title,
    sections: [],
    sourceCardIds: sources.map(card => card.id),
    sourceCardTitles: sources.map(card => card.title),
    preservedText: text,
    changes,
  });
}

export function buildCanonicalRewrite(
  draft: string,
  cards: KnowledgeCard[]
): CanonicalRewrite | null {
  cards = cards
    .map(getApprovedVersion)
    .filter((card): card is KnowledgeCard => card !== null);
  const labs = cards.filter((card): card is LaboratoryCard => card.type === "laboratory");
  const equipment = namedEquipmentMentions(draft, recordedEquipmentModels(labs));
  if (equipment.length && !scopedEquipmentLab(equipment, labs) &&
      !interviewTopic.test(draft) && !/^\s*[—–-]\s+\S.*[?？]\s*$/mu.test(draft)) return null;
  const samples = FACT_CHECK_PRESETS.some(preset => evidenceKey(preset.text) === evidenceKey(draft));
  const equipmentName = equipment.length === 1 ? normalize(
    [equipment[0].kind, equipment[0].model, equipment[0].variant].filter(Boolean).join(" ")
  ) : "";
  const lookup = officialScope(draft, cards, true) !== undefined ||
    (equipmentName && normalize(draft.replace(/^(?:кто\s+такой|что\s+такое)\s+/iu, "")) === equipmentName);
  if (!samples && !lookup) return preservedRewrite(draft, cards);
  if (equipment.length) {
    const lab = scopedEquipmentLab(equipment, labs);
    return lab
      ? buildScopedRewrite(lab.title, lab.referenceDescription, [], [lab])
      : null;
  }
  const normalizedDraft = normalize(draft);
  const draftRoots = new Set(tokenRoots(draft));
  const referencedCards = cards.filter((card) =>
    isCardReferenced(card, draftRoots, normalizedDraft)
  );

  const project =
    referencedCards.find(
      (card): card is ProjectCard => card.type === "project" && card.isJoint
    ) ??
    referencedCards.find(
      (card): card is ProjectCard => card.type === "project"
    ) ??
    null;

  const lab =
    referencedCards.find(
      (card): card is LaboratoryCard => card.type === "laboratory"
    ) ?? null;

  const campus =
    referencedCards.find(
      (card): card is CampusCard => card.type === "campus"
    ) ??
    (normalizedDraft.includes("кампус")
      ? (cards.find((card): card is CampusCard => card.type === "campus") ??
        null)
      : null);

  if (project) {
    return buildProjectRewrite(project, lab, campus);
  }

  if (lab) {
    return buildLabRewrite(lab, campus);
  }

  if (
    campus &&
    (referencedCards.includes(campus) ||
      checkFactText(draft, [campus]).findings.some((finding) =>
        finding.sourceCardId === campus.id && finding.level === "red"
      )) &&
    (universitiesIn(draft).length === 0 ||
      (universitiesIn(sentenceAt(draft, 0)).length === 0 &&
        /кампус/i.test(sentenceAt(draft, 0))))
  ) {
    return buildCampusRewrite(campus);
  }

  return null;
}
