import {
  AUDIT_STOP_RULES,
  type AuditStopCategory,
} from "./audit-canon-registry";
import {
  getFolderPathLabel,
  getUniversityById,
  getUniversityFullName,
  getUniversityName,
  getApprovedVersion,
  type UniversityCard,
  placementStatusLabels,
  type CampusCard,
  type KnowledgeCard,
  type LaboratoryCard,
  type ProjectCard,
} from "./knowledge";
import { universities } from "./data";

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
  quoteStart?: number;
  quoteEnd?: number;
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
  if (
    !/[.!?]/.test(text[index]) ||
    (index + 1 < text.length && !/\s/.test(text[index + 1]))
  )
    return false;
  if (
    text[index] === "." &&
    /(?:тыс|кв|г|гг|гост|корп|уч|млн|млрд|авг|сент|эт|студ)\.$/i.test(
      text.slice(Math.max(0, index - 8), index + 1)
    )
  )
    return false;
  return true;
}

function sentenceAt(text: string, index: number): string {
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

  const sentence = text.slice(start, end).trim();

  if (sentence.length <= 280) return sentence;

  return `${sentence.slice(0, 277).trimEnd()}…`;
}

function quoteFor(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);

  if (!match || match.index === undefined) return null;

  return sentenceAt(text, match.index);
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

function isOfficialCampusMeasure(
  card: CampusCard,
  kind: "area" | "cost" | "places",
  value: number,
  claim: string
): boolean {
  let sources: string[] = [];
  if (kind === "area") {
    const metric = card.campusMetrics.find((item) =>
      /площад/i.test(item.label)
    );
    if (!metric) return false;
    const noteParts = metric.note.split(/[,;](?!\d)/);
    const specific = /земл|участ/i.test(claim)
      ? /земл|участ/i
      : /жилая|жилой|жил[а-яё]*\s+част/i.test(claim)
        ? /жилая|жилой/i
        : /(?<![а-яё])унк(?![а-яё])|учебно[- ]научн/i.test(claim)
          ? /унк|учебно[- ]научн/i
          : null;
    sources = specific
      ? noteParts.filter((part) => specific.test(part))
      : [metric.value];
  } else if (kind === "cost") {
    sources = card.campusMetrics
      .filter((metric) => /стоим|инвест|грант/i.test(metric.label))
      .flatMap((metric) => [metric.value, metric.note]);
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
    } else
      sources = card.campusMetrics
        .filter((metric) => /вместимость/i.test(metric.label))
        .flatMap((metric) => [metric.value, metric.note]);
  }
  const unit =
    kind === "area"
      ? "(?:м²|м2|кв\\.?\\s*м(?:етр[а-яё]*)?)"
      : kind === "cost"
        ? "млрд"
        : "мест[а-яё]*";
  const pattern = new RegExp(
    `(\\d[\\d \u00a0.,]*?)(?:[–—-](\\d[\\d \u00a0.,]*?))?\\s*(тыс\\.?\\s*)?${unit}`,
    "gi"
  );
  return sources.some((source) =>
    Array.from(source.matchAll(pattern)).some((match) => {
      const multiplier = kind === "area" && match[3] ? 1000 : 1;
      const low = parseNumeric(match[1]) * multiplier;
      const high = parseNumeric(match[2] ?? match[1]) * multiplier;
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

const activePlacementPattern =
  /(?:уже|сейчас|сегодня)\s+(?:работает|работают|работала|работал|действует|функционирует|запущен[а-яё]*|открыт[а-яё]*)|функционирует|введен[а-яё]*\s+в\s+эксплуатацию|открыт[а-яё]*\s+в\s+(?:унк|учебно)/i;

const campusPlacementPattern =
  /(?:в|на)\s+(?:новом\s+)?(?:унк|учебно[- ]научн[а-яё]*\s+корпус[а-яё]*|кампус[а-яё]*)/i;

function isContourSentence(sentence: string): boolean {
  return (
    /контур[а-яё]*/i.test(sentence) ||
    /(?:в|на)\s+(?:рамках\s+|программе\s+)?(?:пиш|умноц)(?![а-яё])/i.test(
      sentence
    ) ||
    /передов[а-яё]*\s+инженерн[а-яё]*\s+школ[а-яё]*/i.test(sentence) ||
    /собственн[а-яё]*\s+(?:проект[а-яё]*\s+вуза|инициатив[а-яё]*)/i.test(
      sentence
    )
  );
}

function contourInSentence(sentence: string): string | null {
  if (
    /(?:пиш|передов[а-яё]*\s+инженерн[а-яё]*\s+школ[а-яё]*)/i.test(sentence)
  ) {
    return "ПИШ";
  }

  if (/(?:умноц|межвузовск[а-яё]*\s+научно)/i.test(sentence)) {
    return "УМНОЦ";
  }

  if (
    /собственн[а-яё]*\s+(?:проект[а-яё]*\s+вуза|инициатив[а-яё]*)/i.test(
      sentence
    )
  ) {
    return "собственный проект вуза";
  }

  if (/кампус[а-яё]*/i.test(sentence)) {
    return "кампус";
  }

  return null;
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

/** Scope at the claim, never at the whole document. Commas in decimals stay intact. */
function claimClause(text: string, index: number): string {
  const separatorAt = (position: number) =>
    /[;\n]/.test(text[position]) ||
    isSentenceBoundary(text, position) ||
    (text[position] === "," && !/\d/.test(text[position + 1] ?? ""));
  let start = index;
  let end = index;
  while (start > 0 && !separatorAt(start - 1)) start--;
  while (end < text.length && !separatorAt(end)) end++;
  return text.slice(start, end).trim();
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

export function checkFactText(
  draft: string,
  cards: KnowledgeCard[]
): FactCheckResult {
  cards = cards
    .map(getApprovedVersion)
    .filter((card): card is KnowledgeCard => card !== null);
  const findings: FactCheckFinding[] = [];
  const normalizedDraft = normalize(draft);
  const draftRoots = new Set(tokenRoots(draft));
  const exactDescriptionCard = cards.find(
    (card) =>
      normalize(card.referenceDescription).length > 40 &&
      normalize(card.referenceDescription) === normalizedDraft
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

  const referencedProjects = referencedCards.filter(
    (card): card is ProjectCard => card.type === "project"
  );
  const referencedLabs = referencedCards.filter(
    (card): card is LaboratoryCard => card.type === "laboratory"
  );

  const primaryProject =
    referencedProjects.find((card) => card.isJoint) ?? referencedProjects[0];

  referencedProjects.forEach((project) => {
    const patternMatch = singleAuthorPatterns
      .map((pattern) => quoteFor(draft, pattern))
      .find((quote): quote is string => Boolean(quote));

    if (project.isJoint) {
      const participantNames = project.participantUniversityIds
        .map((universityId) => getUniversityName(universityId))
        .join(" и ");

      const namedParticipants = project.participantUniversityIds.filter(
        (universityId) => universityMentioned(universityId, draft)
      );
      const attributiveVerb = /(?:разраб|созда|сделан|принадлеж|автор)/i.test(
        draft
      );
      const singleNamedAuthor =
        namedParticipants.length === 1 && attributiveVerb
          ? sentenceAt(draft, draft.search(/(?:разраб|созда|принадлеж)/i))
          : null;

      if (!patternMatch && !singleNamedAuthor) return;

      findings.push(
        createFinding({
          level: "red",
          checkpoint: "authorship",
          title: "Совместный проект приписан одному вузу",
          quote: patternMatch ?? singleNamedAuthor ?? "",
          explanation:
            "«" +
            project.title +
            "» — совместная разработка " +
            participantNames +
            ". Карточка прямо запрещает приписывать результат одному вузу или партнёру.",
          suggestion:
            "Укажите оба вуза и их роли: инициатор — " +
            getUniversityName(project.initiatorUniversityId) +
            ", соисполнитель — " +
            (project.coExecutors.join(", ") || "нет") +
            ". Например: «Совместный проект " +
            participantNames +
            "».",
          ...sourceFromCard(project),
        })
      );

      return;
    }

    if (project.coExecutors.length > 0 && patternMatch) {
      findings.push(
        createFinding({
          level: "red",
          checkpoint: "authorship",
          title: "Не указаны соисполнители проекта",
          quote: patternMatch,
          explanation:
            "У проекта «" +
            project.title +
            "» в карточке указаны соисполнители: " +
            project.coExecutors.join(", ") +
            ". Приписывать результат только инициатору нельзя.",
          suggestion:
            "Добавьте соисполнителей: " +
            project.coExecutors.join(", ") +
            ", и укажите вклад каждой стороны.",
          ...sourceFromCard(project),
        })
      );
    }
  });

  referencedLabs.forEach((lab) => {
    const activeSentence = activePlacementPattern.test(draft)
      ? (quoteFor(draft, activePlacementPattern) ??
        sentenceAt(draft, draft.search(activePlacementPattern)))
      : null;

    if (
      lab.placementStatus === "planned" &&
      activeSentence &&
      !/(?:нельзя\s+(?:писать|описывать|утверждать)|планируется\s+к\s+открытию|до\s+завершения|до\s+открытия)/i.test(
        activeSentence
      )
    ) {
      findings.push(
        createFinding({
          level: "red",
          checkpoint: "placement",
          title: "Лаборатория выдана за уже работающую",
          quote: activeSentence,
          explanation:
            "В карточке статус «" +
            placementStatusLabels[lab.placementStatus] +
            "». " +
            lab.placementDetails +
            ". Писать, что объект уже работает в УНК кампуса, нельзя.",
          suggestion:
            "Замените утверждение на «планируется к открытию в УНК кампуса в 2027 году» и не указывайте действующий адрес до ввода объекта.",
          ...sourceFromCard(lab),
        })
      );
    }

    const campusSentence = campusPlacementPattern.test(draft)
      ? (quoteFor(draft, campusPlacementPattern) ??
        sentenceAt(draft, draft.search(campusPlacementPattern)))
      : null;

    if (
      lab.placementStatus === "active" &&
      campusSentence &&
      !/(?:будущ[а-яё]*|планир[а-яё]*|нов[а-яё]*\s+лаборатор[а-яё]*|совместн[а-яё]*\s+с\s+гк|в\s+2027|нельзя\s+(?:утверждать|писать|описывать))/i.test(
        campusSentence
      )
    ) {
      findings.push(
        createFinding({
          level: "red",
          checkpoint: "placement",
          title: "Лаборатория перенесена в УНК кампуса",
          quote: campusSentence,
          explanation:
            "В карточке статус «" +
            placementStatusLabels[lab.placementStatus] +
            "»: " +
            lab.placementDetails +
            ".",
          suggestion:
            "Укажите фактическую площадку вуза из карточки и не переносите лабораторию в УНК кампуса.",
          ...sourceFromCard(lab),
        })
      );
    }
  });

  const contourSentences = draft
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((sentence) => isContourSentence(sentence));

  referencedProjects.forEach((project) => {
    contourSentences.forEach((sentence) => {
      const intendedContour = contourInSentence(sentence);

      if (!intendedContour || intendedContour === project.contour) return;

      const sentenceRoots = new Set(tokenRoots(sentence));
      const normalizedSentence = normalize(sentence);
      const matchingProjectsInSentence = referencedProjects.filter(
        (candidate) =>
          termMatches(candidate.title, sentenceRoots) ||
          normalizedSentence.includes(
            normalize(candidate.title.replace(/\([^)]*\)/g, "").trim())
          )
      );

      // Если в предложении явно названы конкретные проекты, проверяем контур только для них
      if (
        matchingProjectsInSentence.length > 0 &&
        !matchingProjectsInSentence.some(
          (candidate) => candidate.id === project.id
        )
      ) {
        return;
      }

      findings.push(
        createFinding({
          level: "red",
          checkpoint: "contour",
          title: "Проект отнесён к чужому контуру",
          quote: sentenceAt(draft, draft.indexOf(sentence)),
          explanation:
            "В карточке проекта контур — «" +
            project.contour +
            "», а в черновике указан «" +
            intendedContour +
            "».",
          suggestion:
            "Исправьте контур на «" +
            project.contour +
            "»: контуры кампуса, ПИШ, УМНОЦ и собственных проектов вузов не смешиваются.",
          ...sourceFromCard(project),
        })
      );
    });
  });

  if (campusCard) {
    const areaRegex =
      /(\d[\d\s.,]*)\s*(тыс\.?\s*)?(?:кв\.?\s*м(?:2|²)?|кв\.?\s*метр[а-яё]*|м(?:2|²)|квадратн[а-яё]*\s+метр[а-яё]*)/gi;
    const seenAreas = new Set<string>();
    let areaMatch: RegExpExecArray | null;

    while ((areaMatch = areaRegex.exec(draft)) !== null) {
      const sentence = sentenceAt(draft, areaMatch.index);

      if (!isCampusClaim(draft, areaMatch.index)) continue;

      const value = parseNumeric(areaMatch[1] ?? "");
      const multiplied = areaMatch[2] ? value * 1000 : value;

      if (!Number.isFinite(multiplied)) continue;

      const key = String(Math.round(multiplied));
      if (seenAreas.has(key)) continue;
      seenAreas.add(key);

      if (
        !isOfficialCampusMeasure(
          campusCard,
          "area",
          multiplied,
          claimClause(draft.slice(0, areaMatch.index + 1), areaMatch.index)
        )
      ) {
        findings.push(
          createFinding({
            level: "red",
            checkpoint: "campus",
            title: "Площадь кампуса не совпадает с паспортом",
            quote: sentence,
            explanation: `Показатель ${formatArea(multiplied)} не совпадает с соответствующей площадью в утверждённой версии паспорта: ${campusCard.campusMetrics
              .filter((metric) => /площад/i.test(metric.label))
              .map(
                (metric) => `${metric.label}: ${metric.value}. ${metric.note}`
              )
              .join("; ")}`,
            suggestion:
              "Используйте показатель соответствующего объекта из паспорта; общая, жилая, земельная площадь и площадь УНК различаются.",
            ...sourceFromCard(campusCard),
          })
        );
      }
    }

    const costRegex = /(\d[\d\s.,]*)\s*млрд/gi;
    let costMatch: RegExpExecArray | null;

    while ((costMatch = costRegex.exec(draft)) !== null) {
      const sentence = sentenceAt(draft, costMatch.index);

      if (!isCampusClaim(draft, costMatch.index)) continue;

      const value = parseNumeric(costMatch[1] ?? "");

      if (
        Number.isFinite(value) &&
        !isOfficialCampusMeasure(
          campusCard,
          "cost",
          value,
          claimClause(draft, costMatch.index)
        )
      ) {
        findings.push(
          createFinding({
            level: "red",
            checkpoint: "campus",
            title:
              "Стоимость или объём финансирования не совпадает с паспортом",
            quote: sentence,
            explanation: `В утверждённом паспорте: ${campusCard.campusMetrics
              .filter((metric) => /стоим|инвест|грант/i.test(metric.label))
              .map(
                (metric) => `${metric.label}: ${metric.value}. ${metric.note}`
              )
              .join("; ")}. В черновике другое значение.`,
            suggestion:
              "Уточните сумму с привязкой к году расчёта и структуре финансирования по паспорту CAMPUS-PASS-001.",
            ...sourceFromCard(campusCard),
          })
        );
      }
    }

    const placesRegex =
      /(\d[\d\s.,]*)\s*(?:учебн[а-яё]*\s+|жилых\s+)?мест[а-яё]*/gi;
    let placesMatch: RegExpExecArray | null;

    while ((placesMatch = placesRegex.exec(draft)) !== null) {
      const sentence = sentenceAt(draft, placesMatch.index);

      if (!isCampusClaim(draft, placesMatch.index)) continue;

      const value = parseNumeric(placesMatch[1] ?? "");

      if (
        Number.isFinite(value) &&
        !isOfficialCampusMeasure(
          campusCard,
          "places",
          value,
          campusMeasureContext(draft, placesMatch.index)
        )
      ) {
        findings.push(
          createFinding({
            level: "red",
            checkpoint: "campus",
            title: "Число мест не совпадает с паспортом кампуса",
            quote: sentence,
            explanation: `В утверждённом паспорте: ${campusCard.campusMetrics
              .filter((metric) => /вместимость|этап/i.test(metric.label))
              .map(
                (metric) => `${metric.label}: ${metric.value}. ${metric.note}`
              )
              .join("; ")}. В черновике другое число мест.`,
            suggestion:
              "Укажите число мест соответствующей очереди или общую вместимость по паспорту. Численность обучающихся — отдельный показатель.",
            ...sourceFromCard(campusCard),
          })
        );
      }
    }

    const queueRegex =
      /(?<![A-Za-zА-Яа-я0-9])(III|II|I|3|2|1|перв[а-яё]*|втор[а-яё]*|трет[а-яё]*)(?:-?[яей])?\s*(?:очеред[а-яё]*|этап[а-яё]*)[^.!?]{0,45}?(\d{4})(?!\d)/gi;
    let queueMatch: RegExpExecArray | null;

    while ((queueMatch = queueRegex.exec(draft)) !== null) {
      if (!isCampusClaim(draft, queueMatch.index)) continue;
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
      const isValid =
        queue && officialQueueYears(campusCard, queue).includes(year);

      if (!queue || !Number.isFinite(year) || isValid) {
        continue;
      }

      findings.push(
        createFinding({
          level: "red",
          checkpoint: "campus",
          title: "Срок очереди кампуса не совпадает с паспортом",
          quote: sentenceAt(draft, queueMatch.index),
          explanation: `Указанный срок отсутствует у этой очереди в утверждённом паспорте. Подтверждённые годы: ${officialQueueYears(campusCard, queue).join(", ") || "не заданы"}.`,
          suggestion:
            "Уточните очередь, вид срока (строительство/полный запуск) и год по паспорту.",
          ...sourceFromCard(campusCard),
        })
      );
    }

    const nameRegex = /кампус[а-яё]*\s*[«"]([^»"]{3,80})[»"]/gi;
    let nameMatch: RegExpExecArray | null;

    while ((nameMatch = nameRegex.exec(draft)) !== null) {
      const name = normalize(nameMatch[1] ?? "");

      if (name.includes("южный урал")) continue;

      findings.push(
        createFinding({
          level: "red",
          checkpoint: "campus",
          title: "Официальное название кампуса искажено",
          quote: sentenceAt(draft, nameMatch.index),
          explanation:
            "Официальное название объекта — Межуниверситетский кампус мирового уровня «Южный Урал». В черновике использовано другое название.",
          suggestion: "Замените название на официальное: кампус «Южный Урал».",
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
    const rawNumber = figureMatch[1] ?? "";
    const key = `${figureMatch.index}:${rawNumber}`;

    if (seenFigures.has(key)) continue;

    seenFigures.add(key);

    const quote = sentenceAt(draft, figureMatch.index);
    const clause = claimClause(draft, figureMatch.index);
    const universityId = scopedUniversity(draft, figureMatch.index);
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
    const campusScope =
      isCampusClaim(draft, figureMatch.index) ||
      (universityIds.length === 0 &&
        Boolean(
          campusCard?.campusMetrics.some((metric) =>
            normalize(clause).includes(normalize(metric.label))
          )
        ));
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

    if (universityCard) {
      const candidates = universityCard.structuredMetrics.filter(
        (metric) => metric.year === year && sameUnit(metric.unit, unit)
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
            quote,
            explanation: `${getUniversityName(universityCard.universityId)}: ${metric.label} — ${metric.value} ${metric.unit}, ${metric.year}, ${metric.kind === "plan" ? "план" : "факт"}. Проверено ${metric.verifiedAt}; ответственный: ${metric.owner}.`,
            suggestion: matches
              ? "Сохраните год, статус и ссылку на документ."
              : "Уточните число, год и статус факт/план по документу в карточке этого вуза.",
            ...sourceFromCard(universityCard),
            sourceUrl: metric.evidenceUrl,
          })
        );
        continue;
      }
    } else if (sourceCard) {
      // Legacy free-text figures can support only the matching unit in this entity.
      const sources = [
        sourceCard.referenceDescription,
        ...(sourceCard.type === "project"
          ? sourceCard.confirmedFigures
          : sourceCard.type === "laboratory"
            ? sourceCard.confirmedIndicators
            : sourceCard.type === "campus"
              ? sourceCard.campusMetrics.flatMap((metric) => [
                  metric.value,
                  metric.note,
                ])
              : []),
      ];
      const confirmed = sources.some((source) =>
        Array.from(source.matchAll(new RegExp(figureRegex.source, "gi"))).some(
          (match) =>
            sameUnit(unit, match[3] ?? "") && parseNumeric(match[1]) === value
        )
      );
      if (confirmed) continue;
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
        title: "Цифра не подтверждена официальными данными",
        quote,
        explanation:
          "Метрики «" +
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
    const match = rule.pattern.exec(draft);
    if (!match || match.index === undefined) continue;

    // Если в документе целиком явно указаны оба соавтора (МИДиС и ЮУГМУ)
    // и не сработало прямое утверждение о единоличном авторстве, не штрафуем за повтор названия проекта в следующих разделах.
    if (
      rule.id === "RULE-COOP-TRAUMA" &&
      !/полностью\s+разработан|разработал\s+артур/i.test(match[0]) &&
      /мидис/i.test(draft) &&
      /юугму/i.test(draft)
    ) {
      continue;
    }

    const checkpoint = AUDIT_CATEGORY_TO_CHECKPOINT[rule.category];
    const targetCard = cards.find((card) => card.id === rule.sourceCardId);
    if (!targetCard) continue;
    const matchQuote = sentenceAt(draft, match.index);

    if (
      rule.id === "RULE-245-PRODUCTS-5REGIONS" &&
      /(?:пят[а-яё]*\s+(?:пилотн[а-яё]*\s+)?регион|сводн[а-яё]+\s+показател|федеральн[а-яё]+\s+показател)/i.test(
        matchQuote
      )
    ) {
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
        suggestion: rule.canonicalCorrection,
        ...sourceFromCard(targetCard),
      })
    );
  }

  if (primaryProject) {
    const titleInDraft = normalizedDraft.includes(
      normalize(primaryProject.title)
    );

    if (titleInDraft) {
      findings.push(
        createFinding({
          level: "green",
          checkpoint: "names",
          title: "Название проекта совпадает с карточкой",
          quote: primaryProject.title,
          explanation:
            "Официальное название проекта в черновике совпадает с карточкой-источником.",
          suggestion: "Оставьте формулировку без изменений.",
          ...sourceFromCard(primaryProject),
        })
      );
    }

    const sphereRoots = uniqueRoots(primaryProject.sphere);
    const themeMatched = sphereRoots.some((root) => draftRoots.has(root));

    if (themeMatched) {
      findings.push(
        createFinding({
          level: "green",
          checkpoint: "names",
          title: "Тематика проекта подтверждена",
          quote: primaryProject.sphere,
          explanation:
            "Сфера проекта в черновике совпадает с полем «Сфера» карточки.",
          suggestion: "Тематику можно оставить без изменений.",
          ...sourceFromCard(primaryProject),
        })
      );
    }
  }

  const geographyMatched =
    /кампус/i.test(draft) && normalizedDraft.includes("челябинск");

  if (geographyMatched) {
    const geographyCard =
      campusCard ?? primaryProject ?? referencedLabs[0] ?? null;

    if (geographyCard) {
      findings.push(
        createFinding({
          level: "green",
          checkpoint: "campus",
          title: "География подтверждена базой",
          quote:
            /Челябинск[а-яё]*|Челябинской\s+области/i.exec(draft)?.[0] ??
            "Челябинск",
          explanation:
            "Кампус «Южный Урал» и проекты базы привязаны к Челябинской области — география в черновике корректна.",
          suggestion: "Географию можно оставить без изменений.",
          ...sourceFromCard(geographyCard),
        })
      );
    }
  }

  if (findings.length === 0) {
    const exactCard = cards.find(
      (card) =>
        normalize(card.referenceDescription).length > 40 &&
        normalize(card.referenceDescription) === normalizedDraft
    );
    findings.push(
      exactCard
        ? createFinding({
            level: "green",
            checkpoint: "names",
            title: "Описание совпадает с официальной карточкой",
            quote: draft.trim(),
            explanation:
              "Текст полностью совпадает с утверждённым описанием карточки.",
            suggestion: "Сохраните ссылку на официальную карточку.",
            ...sourceFromCard(exactCard),
          })
        : createFinding({
            level: "yellow",
            checkpoint: "figures",
            title: "Подтверждение не найдено",
            quote: draft.trim(),
            explanation:
              "Для текста не найден проверяемый факт в официальных карточках. Отсутствие найденных противоречий не подтверждает текст.",
            suggestion:
              "Уточните предмет проверки и добавьте официальный источник.",
            ...noSource,
          })
    );
  }
  for (const finding of findings) {
    const offset = draft.indexOf(finding.quote);
    if (
      offset >= 0 &&
      finding.quote &&
      draft.indexOf(finding.quote, offset + 1) < 0
    ) {
      finding.quoteStart = offset;
      finding.quoteEnd = offset + finding.quote.length;
    }
  }
  const deduped = Array.from(
    new Map(findings.map((finding) => [finding.id, finding])).values()
  );

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
    coverage:
      summary.red || summary.yellow
        ? summary.green
          ? "partial"
          : "unverified"
        : "confirmed",
    checkedChars: draft.trim().length,
  };
}

function pickParticipants(project: ProjectCard): string[] {
  if (project.isJoint) {
    return Array.from(
      new Set(
        project.participantUniversityIds.map((universityId) =>
          getUniversityName(universityId)
        )
      )
    );
  }

  return Array.from(
    new Set([
      getUniversityName(project.initiatorUniversityId),
      ...project.coExecutors,
    ])
  );
}

function buildProjectRewrite(
  project: ProjectCard,
  lab: LaboratoryCard | null,
  campus: CampusCard | null
): CanonicalRewrite {
  const initiatorName = getUniversityName(project.initiatorUniversityId);
  const participants = pickParticipants(project);
  const isJoint = project.isJoint;
  const title = isJoint
    ? `${project.title}: совместный проект ${participants.join(" и ")}`
    : `${project.title}: ${project.sphere}`;

  const lead = [
    project.referenceDescription,
    `Контур проекта «${project.title}» — «${project.contour}».`,
    `В карточке подтверждены: ${project.confirmedFigures.join("; ")}.`,
  ].join(" ");

  const sections: CanonicalRewriteSection[] = [
    {
      id: "participants",
      heading: "Кто участвует",
      level: 2,
      chunks: [
        {
          id: "participants-1",
          content: isJoint
            ? `Инициатор проекта — ${initiatorName}. Совместная разработка ${participants.join(" и ")}. Индустриальный партнёр — ${project.industrialPartner}. Проект хранится одной карточкой в разделе «02_Совместные_проекты»: нельзя закреплять результат за одним участником.`
            : `Инициатор проекта — ${initiatorName}. Соисполнители — ${project.coExecutors.join(", ") || "нет"}. Индустриальный партнёр — ${project.industrialPartner}.`,
        },
      ],
    },
    {
      id: "result",
      heading: "Что создано и в каком контуре",
      level: 2,
      chunks: [
        {
          id: "result-1",
          content: isJoint
            ? `Совместный проект ${participants.join(" и ")} «${project.title}» находится на стадии «${project.readinessStage}» и развивается в контуре «${project.contour}». Подтверждённые результаты: ${project.confirmedFigures.join("; ")}.`
            : `Проект «${project.title}» находится на стадии «${project.readinessStage}» и развивается в контуре «${project.contour}». Подтверждённые результаты: ${project.confirmedFigures.join("; ")}.`,
        },
      ],
    },
  ];

  if (lab) {
    sections.push({
      id: "lab-status",
      heading: "Статус лаборатории",
      level: 2,
      chunks: [
        {
          id: "lab-status-1",
          content: `${lab.title} (${lab.affiliation}) — ${placementStatusLabels[lab.placementStatus].toLowerCase()}. ${lab.placementDetails}. Партнёр — ${lab.partner}, руководитель — ${lab.head}.${
            lab.placementStatus === "planned"
              ? " До открытия объект нельзя описывать как действующую площадку в УНК кампуса."
              : ""
          }`,
        },
      ],
    });
  }

  if (campus) {
    sections.push({
      id: "campus",
      heading: "Параметры кампуса",
      level: 2,
      chunks: [
        {
          id: "campus-1",
          content: `Кампус «Южный Урал»: ${campus.campusMetrics
            .map((metric) => `${metric.label.toLowerCase()} — ${metric.value}`)
            .join("; ")}.`,
        },
      ],
    });
  }

  const sourceCards: KnowledgeCard[] = [
    project,
    ...(lab ? [lab] : []),
    ...(campus ? [campus] : []),
  ];
  const plainText = [
    title,
    lead,
    ...sections.flatMap((section) => [
      section.heading,
      ...section.chunks.map((chunk) => chunk.content),
    ]),
  ].join("\n\n");

  return {
    title,
    lead,
    sections,
    sourceCardIds: sourceCards.map((card) => card.id),
    sourceCardTitles: sourceCards.map((card) => card.title),
    plainText,
  };
}

function buildLabRewrite(
  lab: LaboratoryCard,
  campus: CampusCard | null
): CanonicalRewrite {
  const title = `${lab.title}: ${lab.affiliation}`;
  const lead = `${lab.referenceDescription} Статус размещения — ${placementStatusLabels[lab.placementStatus].toLowerCase()}: ${lab.placementDetails}.`;
  const sections: CanonicalRewriteSection[] = [
    {
      id: "lab-status",
      heading: "Статус и площадка",
      level: 2,
      chunks: [
        {
          id: "lab-status-1",
          content: `${lab.title} (${lab.affiliation}) — ${placementStatusLabels[lab.placementStatus].toLowerCase()}. ${lab.placementDetails}.`,
        },
      ],
    },
    {
      id: "lab-directions",
      heading: "Направления работы",
      level: 2,
      chunks: [
        {
          id: "lab-directions-1",
          content: `Направления: ${lab.workDirections.join("; ")}. Оборудование: ${lab.equipment.join("; ")}.`,
        },
        {
          id: "lab-directions-2",
          content: `Партнёр — ${lab.partner}, руководитель — ${lab.head}. Подтверждённые показатели: ${lab.confirmedIndicators.join("; ")}.`,
        },
      ],
    },
  ];

  if (campus) {
    sections.push({
      id: "campus",
      heading: "Параметры кампуса",
      level: 2,
      chunks: [
        {
          id: "campus-1",
          content: `Кампус «Южный Урал»: ${campus.campusMetrics
            .map((metric) => `${metric.label.toLowerCase()} — ${metric.value}`)
            .join("; ")}.`,
        },
      ],
    });
  }

  const sourceCards: KnowledgeCard[] = [lab, ...(campus ? [campus] : [])];
  const plainText = [
    title,
    lead,
    ...sections.flatMap((section) => [
      section.heading,
      ...section.chunks.map((chunk) => chunk.content),
    ]),
  ].join("\n\n");

  return {
    title,
    lead,
    sections,
    sourceCardIds: sourceCards.map((card) => card.id),
    sourceCardTitles: sourceCards.map((card) => card.title),
    plainText,
  };
}

function buildCampusRewrite(campus: CampusCard): CanonicalRewrite {
  const title =
    "Межуниверситетский кампус мирового уровня «Южный Урал»: канонические параметры и 7 вузов-резидентов";
  const lead = campus.referenceDescription;
  const sections: CanonicalRewriteSection[] = [
    {
      id: "campus-metrics",
      heading: "Площади, инвестиции, этапы и вместимость",
      level: 2,
      chunks: [
        {
          id: "campus-metrics-1",
          content: campus.campusMetrics
            .map(
              (metric) => `${metric.label}: ${metric.value} (${metric.note})`
            )
            .join(". "),
        },
        {
          id: "campus-metrics-2",
          content: `Тарифы на проживание (ООО «Отельные решения», «Три звезды»): ${campus.tariffs
            .map((tariff) => `${tariff.label} — ${tariff.value}`)
            .join("; ")}.`,
        },
      ],
    },
    {
      id: "campus-entities",
      heading: "Участники, юридические лица и стоп-лист",
      level: 2,
      chunks: [
        {
          id: "campus-entities-1",
          content: `В проекте кампуса «Южный Урал» участвуют 7 равноправных вузов: ЮУрГУ, ЧелГУ, МИДиС (единственный частный), ЮУГМУ, ЮУрГАУ, МГТУ им. Г. И. Носова и ЮУрГГПУ. Юрлица: ${campus.legalEntities
            .map((entity) => `${entity.name} — ${entity.role}`)
            .join("; ")}.`,
        },
      ],
    },
  ];

  const plainText = [
    title,
    lead,
    ...sections.flatMap((section) => [
      section.heading,
      ...section.chunks.map((chunk) => chunk.content),
    ]),
  ].join("\n\n");

  return {
    title,
    lead,
    sections,
    sourceCardIds: [campus.id],
    sourceCardTitles: [campus.title],
    plainText,
  };
}

export function buildCanonicalRewrite(
  draft: string,
  cards: KnowledgeCard[]
): CanonicalRewrite | null {
  cards = cards
    .map(getApprovedVersion)
    .filter((card): card is KnowledgeCard => card !== null);
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
    (normalizedDraft.includes("кампус") ||
    normalizedDraft.includes("южный урал") ||
    normalizedDraft.includes("челябинск")
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
    (universitiesIn(draft).length === 0 ||
      (universitiesIn(sentenceAt(draft, 0)).length === 0 &&
        /кампус/i.test(sentenceAt(draft, 0))))
  ) {
    return buildCampusRewrite(campus);
  }

  return null;
}
