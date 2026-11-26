import {
  resolveCanonReference,
  type CanonCitation,
  type CanonFact,
  type CanonSource,
} from "./canon-context";
import { campusServices } from "./campus-services";
import { folderIds, getApprovedVersion, isJointProject, type KnowledgeCard } from "./knowledge";
import {
  indexKnowledgeFragment,
  knowledgeQueryTerms,
  matchKnowledgeTerm,
  normalizeKnowledgeText,
  sameKnowledgeWord,
  tokenizeKnowledgeText,
} from "./knowledge-query";
import { knowledgeCardMatch } from "./knowledge-search";

type AssistantGuide = {
  message: string;
  citations: CanonCitation[];
  actions: { label: string; href: string }[];
  presentation?: "summary";
};

const questionWords = new Set(
  "а в во для из к на о об по про с со как какова каков какой какого какая какое какие каких где сколько что кто ли можно пожалуйста подскажите скажите расскажите указано указаны предусмотрено предусмотрены".split(
    " "
  )
);
const navigationVerbs =
  /^(?:откр|найт|иск|перейт|посмотр|провер|подготов|созда|напис|сдела|войти)/u;
const qualifiers = /^(?:не|ни|без|вне|кроме|исключая)$/u;
const serviceButtons = new Set([
  "/knowledge",
  "/editor",
  "/check",
  "/analytics",
  "/login",
]);

function wordsFor(text: string): string[] {
  return tokenizeKnowledgeText(text)
    .join(" ")
    .replace(/(?<!\S)учебно научн[а-я]* корпус[а-я]*(?!\S)/gu, "унк")
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (/^вуз(?:а|е|у|ы|ом|ов|ам|ами|ах)?$/u.test(word)) return "университет";
      if (/^(?:входит|входят|объединяет|объединяют)$/u.test(word))
        return "состав";
      if (/^(?:проектиру|планиру)[а-я]*$/u.test(word)) return "планируемый";
      return word;
    });
}

function has(words: string[], target: string) {
  return words.some((word) => sameKnowledgeWord(word, target));
}

function containsPhrase(words: string[], phrase: string[]) {
  return words.some((_, index) =>
    phrase.every((word, offset) =>
      sameKnowledgeWord(words[index + offset] ?? "", word)
    )
  );
}

export function assistantQuestion(question: string) {
  return question
    .trim()
    .replace(/^(?:кратко|коротко)[,\s]+/iu, "")
    .replace(
      /(?:[.!?,]\s*|\s+)(?:и\s+)?(?:дай(?:те)?|пришли(?:те)?|добавь(?:те)?|укажи(?:те)?)\s+ссылку(?:\s+на\s+(?:источник|карточку|паспорт))?[.!?]*$/iu,
      ""
    )
    .replace(
      /(?:,\s*|\s+)и\s+из\s+каких\s+источников\s+это\s+известно[.!?]*$/iu,
      ""
    );
}

/** Only rephrase complete fields whose scope and qualifications can be carried through. */
export function assistantFactSummary(citation: CanonCitation) {
  const { field, label, quote } = citation;
  if (field === "title") return null;
  let description = quote;
  if (field === "referenceDescription") {
    // Source URLs are removed by the canonical projection. Their trailing,
    // now-empty labels are not part of the factual narrative; the full field
    // remains unchanged in the citation disclosure.
    const paragraphs = quote.trim().split(/\r?\n[\t ]*\r?\n/u);
    const emptyReference = /^([\p{L}][\p{L}\p{N}«»"'.-]{1,31})(?:\s*\(\d{4}-\d{2}-\d{2}\))?\s+[—–-]\s*$/u;
    while (paragraphs.length > 1 && paragraphs.at(-1)!.split(/\r?\n/u).every(line => {
      const label = emptyReference.exec(line.trim())?.[1];
      return !!label && (label.match(/[\p{Lu}]/gu)?.length ?? 0) >= 2;
    })) paragraphs.pop();
    description = paragraphs.join("\n\n").trim();
    if (!description) return null;
  }
  let text = field === "referenceDescription" ? description : `${label} — ${quote}`;
  if (field.startsWith("campusMetrics.")) {
    const total =
      label === "Общая вместимость гостиниц" &&
      quote.match(/^(\d[\d\s]*\d) мест, (\d+) гостиниц(\s+\([\s\S]+\))?$/u);
    const apartments =
      label === "Апартаменты А5" &&
      quote.match(/^(\d+) апартаментов(\s+\([\s\S]+\))?$/u);
    const residents =
      label === "Вузы-резиденты" &&
      quote.match(/^(\d+) вузов(\s+\([\s\S]+\))?$/u);
    if (total)
      text = `Вместимость гостиниц кампуса — ${total[1]} мест в ${total[2]} гостиницах${total[3] ?? ""}`;
    if (apartments)
      text = `Для А5 в паспорте указано ${apartments[1]} апартаментов${apartments[2] ?? ""}`;
    if (residents)
      text = `В составе кампуса — ${residents[1]} вузов-резидентов${residents[2] ?? ""}`;
  }
  return text.length <= 500 ? text : null;
}

export function isCampusStatisticQuestion(question: string) {
  const words = wordsFor(assistantQuestion(question));
  return (
    has(words, "кампус") &&
    words.some(
      (word) =>
        /^(?:сколько|площад|вместимост|апартамент)/u.test(word) ||
        (/^очеред/u.test(word) && words.some((term) => /^гостиниц/u.test(term))) ||
        (word === "университет" &&
          words.some((cue) => cue === "какие" || cue === "состав"))
    )
  );
}

const hotelPhases = {
  first: "Первая очередь гостиниц",
  second: "Вторая очередь гостиниц",
};
type HotelPhase = keyof typeof hotelPhases;
const hotelCapacity = /^(?:\d+\s+(?:(?:жил[а-я]+|гостиничн[а-я]+|студенческ[а-я]+|семиэтажн[а-я]+|шестнадцатиэтажн[а-я]+)\s+)?(?:корп(?:\.|ус(?:а|ов)?)|гостиниц(?:а|ы)?)(?:,\s*|\s*\/\s*|\s+на\s+))?\d[\d \u00a0\u202f]*\s+мест(?:а|о)?$/iu;

function hotelPhaseRequest(words: string[]): HotelPhase[] {
  // The campus name is removed by the caller only when it matches a passport.
  const subject = words.map((word, index) => {
    if (/^(?:перв(?:ая|ую|ой)|1)$/u.test(word)) return "первая";
    if (/^(?:втор(?:ая|ую|ой)|2)$/u.test(word)) return "вторая";
    if (/^[яйю]$/u.test(word) && /^[12]$/u.test(words[index - 1] ?? "")) return "";
    return word;
  }).filter(Boolean).join(" ").replace(/^(?:пожалуйста|скажите|подскажите)\s+/u, "");
  if (/^сколько места? (?:(?:в|во) )?первая очереди гостиниц кампуса$/u.test(subject))
    return ["first"];
  if (/^сколько места? (?:(?:в|во) )?вторая очереди гостиниц кампуса$/u.test(subject))
    return ["second"];
  if (/^сколько места? (?:(?:в|во) )?первая и (?:(?:в|во) )?вторая очередях гостиниц кампуса$/u.test(subject))
    return ["first", "second"];
  if (/^(?:чем отлича[а-я]+|как различа[а-я]+|сравни(?:те)?) первая и вторая очереди гостиниц кампуса$/u.test(subject))
    return ["first", "second"];
  return [];
}

function citeAssistantFact(source: CanonSource, fact: CanonFact) {
  return resolveCanonReference({ sourceId: source.id, factId: fact.id }, [source])!;
}

function legacyHotelEntry(entry: string) {
  const row = entry.match(/^[12]-я\s+\([^()]+\):\s*([^/]+?)(?:\s*\/\s*|\s+на\s+)(\d[\d \u00a0\u202f]*\s+мест(?:а|о)?)$/iu);
  if (!row) return false;
  const buildings = row[1];
  return /^\d+\s+(?:гост\.|гостиниц(?:а|ы)?)$/iu.test(buildings) ||
    /^\d+\s+корп(?:\.|ус(?:а|ов)?)\s+\([^()]*,\s*\d+\s+студ\.\s*\+\s*\d+\s+НПС\)$/iu.test(buildings);
}

function hotelPhaseAnswer(source: CanonSource, phases: HotelPhase[]): AssistantGuide | null {
  const legacy = source.facts.filter(fact => fact.field.startsWith("campusMetrics.") &&
    /^Этапы строительства \(3 очереди\)$/iu.test(fact.label));
  const summaries = phases.map((phase) => {
    const label = hotelPhases[phase];
    const rows = source.facts.filter(fact => fact.field.startsWith("campusMetrics.") && fact.label === label);
    if (rows.length) {
      if (rows.length !== 1 || !hotelCapacity.test(rows[0].text.split(" (", 1)[0])) return null;
      const citation = citeAssistantFact(source, rows[0]);
      const summary = assistantFactSummary(citation);
      return summary ? { citation, summary } : null;
    }
    if (legacy.length !== 1 || legacy[0].text.length > 1200) return null;
    // In the earlier passport, each ordinal's full entry ends at the next
    // semicolon. Keep its date, capacity and any stage qualifiers together.
    const entries = legacy[0].text.match(/^(?:\d{4}\s*\/\s*){2}\d{4}(?:[–-]\d{4})?\s+\((1-я\s+[^;]+);\s*(2-я\s+[^;]+);\s*3-я\s+[^;]+\)$/u);
    const legacyEntry = entries?.[phase === "first" ? 1 : 2];
    return legacyEntry && legacyHotelEntry(legacyEntry)
      ? { citation: citeAssistantFact(source, legacy[0]), summary: legacyEntry }
      : null;
  });
  if (!summaries.every(item => item !== null)) return null;
  const message = summaries.map(({ summary }) => summary).join("\n\n");
  if (message.length > 850) return null;
  const citations = [...new Map(summaries.map(({ citation }) => [citation.factId, citation])).values()];
  return { message, citations, actions: [], presentation: "summary" };
}

const campusBuilding = /(?<!\p{L})в (?:унк|учебно[- ]научном корпусе)(?!\p{L})/iu;
const campusSite = /(?<!\p{L})(?:в (?:межуниверситетском )?кампусе|(?:на (?:площадке|территории|базе)|в корпус(?:е|ах)) (?:межуниверситетского )?кампуса)(?!\p{L})/iu;
const locationPhrase = /(?<!\p{L})(?:на (?:площадке|территории|базе|складе|заводе|стенде)\s|в\s+|по адресу\s|(?:ул|пр)\.\s+)/iu;
const placementAction = /(?<!\p{L})(?:действу(?:ет|ют)|работа(?:ет|ют)|установлен[аоы]?|наход(?:ится|ятся)|(?:размещ|располож)[её]н[аоы]?|хран(?:ится|ятся)|планируется)(?!\p{L})/iu;
const plannedPlacement = /(?<!\p{L})(?:планир[а-я]*|предполага[а-я]*|проектир[а-я]*|будет|ожида[а-я]*)(?!\p{L})/iu;
const equipmentModel = /^(?:[a-z][a-z\d-]+|\p{L}+\d[\p{L}\d-]*)$/u;

function placementStatus(source: CanonSource) {
  return source.facts.find(fact => fact.field === "placementStatus" && plannedPlacement.test(fact.text));
}

/** For named equipment, a place and model must occur in the same statement. */
export function supportsAssistantPlacement(
  source: CanonSource,
  fact: Pick<CanonFact, "field" | "text">,
  question: string,
  query: string,
  affiliation?: string
) {
  if (source.type !== "laboratory") return true;
  const queryWords = tokenizeKnowledgeText(query);
  const models = [...new Set(source.facts.flatMap(item => item.field.startsWith("equipment.")
    ? tokenizeKnowledgeText(item.text).filter(word => equipmentModel.test(word)) : []))];
  const requested = models.filter(model => has(queryWords, model));
  const aliases = source.facts.filter(item => item.field === "title" || item.field === "referenceDescription" || item.field === "placementDetails")
    .flatMap(item => tokenizeKnowledgeText(item.text).filter(word => equipmentModel.test(word)));
  const explicit = queryWords.filter(word => equipmentModel.test(word) || has(aliases, word));
  if (explicit.some(word => !has(models, word))) return false;
  const scope = campusBuilding.test(question) ? campusBuilding : campusSite.test(question) ? campusSite : null;
  if (!requested.length && !scope && !affiliation) return true;

  const placement = source.facts.find(item => item.field === "placementDetails");
  const planned = placementStatus(source);
  const hasAddress = (text: string) => {
    const termsInField = tokenizeKnowledgeText(text);
    const cardAddress = models.length <= 1 && !models.some(model => has(termsInField, model));
    const matchLocation = (clause: string) => {
      const action = placementAction.exec(clause);
      const address = action ? clause.slice(action.index + action[0].length).trimStart() : clause;
      if (scope && !(address.search(scope) === 0 || scope === campusSite && address.search(campusBuilding) === 0))
        return false;
      if (affiliation && !knowledgeQueryTerms(affiliation).every(term => matchKnowledgeTerm(indexKnowledgeFragment(clause), term) >= 0)) return false;
      if (!locationPhrase.test(clause) || planned && !plannedPlacement.test(clause)) return false;
      const terms = tokenizeKnowledgeText(clause);
      const modelInClause = models.filter(model => has(terms, model));
      if (requested.length && modelInClause.some(model => !requested.includes(model))) return false;
      if (requested.length && requested.every(model => has(terms, model))) return action !== null;
      if (!requested.length && !affiliation && action) return true;
      // A short, card-level address can locate the sole catalogued model.
      return cardAddress && !affiliation &&
        /^(?:(?:(?:действует|работает|расположена?)\s+)?(?:на|в|ул\.|пр\.)\s|действующая площадка\s)/iu.test(clause);
    };
    return text.split(/[;,\r\n]|(?<!ул|пр)[.!?]\s+(?=\p{Lu})/u)
      .some(clause => matchLocation(clause.trim()));
  };
  if (fact.field === "affiliation")
    return !scope && !affiliation && (!placement || hasAddress(placement.text));
  if (fact.field === "referenceDescription" && placement) return false;
  if (fact.field !== "placementDetails" && fact.field !== "referenceDescription") return false;
  return hasAddress(fact.text);
}

function equipmentPlacementGuide(question: string, sources: CanonSource[], cards: KnowledgeCard[]): AssistantGuide | null {
  const match = normalizeKnowledgeText(question).match(
    /^где (?:находится|расположен(?:а)?|установлен(?:а)?|работает) (?:([\p{L}\p{N}\s»-]+) с )?(робот(?:ом)?(?:-манипулятор(?:ом)?)? [a-z][a-z\d-]+)[.!?]?$/u
  );
  if (!match) return null;
  const [, objectName, equipmentName] = match;
  const equipment = knowledgeQueryTerms(equipmentName.replace(/^роботом/u, "робот").replace(/-манипулятором /u, "-манипулятор "));
  const object = knowledgeQueryTerms(objectName ?? "");
  const matches = cards.flatMap(input => {
    const card = getApprovedVersion(input);
    if (card?.type !== "laboratory" || !knowledgeCardMatch(card, equipment, "equipment")) return [];
    const names = indexKnowledgeFragment(`${card.title} ${card.affiliation}`);
    if (!object.every(term => matchKnowledgeTerm(names, term) >= 0)) return [];
    const source = sources.find(item => item.cardId === card.id);
    const field = source?.facts.find(fact => fact.field === "placementDetails");
    return source && field && supportsAssistantPlacement(source, field, question, equipmentName, object.length ? card.affiliation : undefined)
      ? [citeAssistantFact(source, field)] : [];
  });
  if (matches.length !== 1) return null;
  const message = assistantFactSummary(matches[0]);
  return message ? {
    message: object.length ? `В карточке указано, где размещён робот.\n\n${message}` : message,
    citations: matches, actions: [], presentation: "summary",
  } : null;
}

function approvedCardList(question: string, sources: CanonSource[], cards: KnowledgeCard[]): AssistantGuide | null {
  const collaborations = /^(?:какие вузы участвуют в совместных проектах|какие университеты участвуют в совместных проектах|кто участвует в совместных проектах)[.!?]?$/u.test(question);
  const ecology = /^(?:какие проекты связаны с экологией|какие есть экологические проекты|какие проекты по экологии)[.!?]?$/u.test(question);
  const placements = /^(?:какие сведения о размещении лабораторий подтверждены|где размещены лаборатории)[.!?]?$/u.test(question);
  if (!collaborations && !ecology && !placements) return null;
  const jointIds = new Set(collaborations ? cards.flatMap(input => {
    const card = getApprovedVersion(input);
    return card && isJointProject(card) ? [card.id] : [];
  }) : []);

  const entries = sources.toSorted((a, b) => a.title.localeCompare(b.title, "ru")).flatMap(source => {
    const field = (key: string) => source.facts.find(fact => fact.field === key);
    let facts: CanonFact[];
    if (collaborations) {
      if (source.type !== "project" || !jointIds.has(source.cardId)) return [];
      const initiator = field("initiatorUniversityId");
      const participants = source.facts.filter(fact => fact.field.startsWith("participantUniversityIds.") && fact.text !== initiator?.text);
      if (!initiator || !participants.length) return [];
      facts = [...new Map([initiator, ...participants].map(fact => [fact.text, fact])).values()];
    } else if (ecology) {
      const sphere = field("sphere");
      if (source.type !== "project" || !sphere || !/^экологи[яиюе](?=\s|[,/]|$)/iu.test(sphere.text)) return [];
      facts = [sphere];
    } else {
      const placement = field("placementDetails");
      if (source.type !== "laboratory" || !placement) return [];
      const status = placementStatus(source);
      facts = status && !placement.text.startsWith(status.text) ? [status, placement] : [placement];
    }
    if (facts.some(fact => fact.text.length > 500)) return [];
    return [{
      line: `${source.title} — ${facts.map(fact => fact.text).join(", ")}`,
      citations: facts.map(fact => citeAssistantFact(source, fact)),
    }];
  });
  const lines: string[] = [];
  const citations: CanonCitation[] = [];
  for (const entry of entries) {
    if (citations.length + entry.citations.length > 6 || [...lines, entry.line].join("\n\n").length > 800)
      continue;
    lines.push(entry.line);
    citations.push(...entry.citations);
  }
  if (!citations.length) return null;
  const incomplete = lines.length < entries.length;
  if (incomplete) lines.unshift("Вот несколько утверждённых карточек по теме.");
  return {
    message: lines.join("\n\n"), citations, presentation: "summary",
    actions: incomplete ? [{
      label: collaborations ? "Совместные проекты" : "Справочник",
      href: collaborations ? `/knowledge?folder=${encodeURIComponent(folderIds.joint)}` : "/knowledge",
    }] : [],
  };
}

function projectOverview(question: string, sources: CanonSource[]): AssistantGuide | null {
  const subject = question.match(/^что известно об? (.+?)[.!?]?$/u)?.[1];
  if (!subject) return null;
  const terms = wordsFor(subject);
  if (terms.length < 2) return null;
  const matches = sources.filter(source =>
    source.type === "project" && terms.every(term => has(wordsFor(source.title), term))
  );
  if (matches.length !== 1) return null;
  const [source] = matches;
  const description = source.facts.find(fact => fact.field === "referenceDescription");
  if (!description || description.text.length > 1200) return null;
  const citation = citeAssistantFact(source, description);
  const message = assistantFactSummary(citation);
  return message ? { message, citations: [citation], actions: [], presentation: "summary" } : null;
}

function matchesAssertion(fact: CanonFact, subject: string[]) {
  // A campus field may bundle several measurements and an explanatory note.
  // The label can identify a measurement, but must not fill gaps in a clause.
  const clauses = fact.text.split(
    /[;()]|\s+\/\s+|[.!?]\s+(?=\p{Lu})|,\s+(?=(?:а|но|тогда как)\s)/u
  );
  return [fact.label, ...clauses].some((clause) => {
    const words = wordsFor(clause);
    return subject.every((word) => has(words, word));
  });
}

function navigationGuide(
  words: string[],
  sources: CanonSource[]
): AssistantGuide | null {
  if (
    !words.some((word) => word === "где" || word === "как") ||
    !words.some((word) => navigationVerbs.test(word))
  )
    return null;
  const subject = words.filter(
    (word) => !questionWords.has(word) && !navigationVerbs.test(word)
  );
  if (has(subject, "паспорт") && has(subject, "кампус")) {
    const matches = sources.filter((source) => {
      const title = wordsFor(source.title);
      return (
        source.type === "campus" && subject.every((word) => has(title, word))
      );
    });
    if (matches.length === 1)
      return {
        message: "Откройте утверждённую версию паспорта кампуса.",
        citations: [],
        actions: [{ label: "Паспорт кампуса", href: matches[0].href }],
      };
  }
  if (
    subject.length === 2 &&
    has(subject, "карточка") &&
    has(subject, "университет")
  )
    return {
      message:
        "В разделе «Университеты-резиденты» выберите вуз и откройте его карточку.",
      citations: [],
      actions: [
        {
          label: "Университеты-резиденты",
          href: `/knowledge?folder=${encodeURIComponent(folderIds.universities)}`,
        },
      ],
    };

  const matches = campusServices(false)
    .filter(({ href }) => serviceButtons.has(href))
    .flatMap((service) =>
      [service.title, service.navTitle, ...service.aliases].flatMap((alias) => {
        const phrase = wordsFor(alias);
        return containsPhrase(words, phrase)
          ? [{ service, score: phrase.length }]
          : [];
      })
    )
    .sort((left, right) => right.score - left.score);
  const best = matches[0]?.service;
  if (!best) return null;
  return {
    message: `Для этой задачи откройте раздел «${best.title}».`,
    citations: [],
    actions: [{ label: best.title, href: best.href }],
  };
}

/** Answers narrow questions from complete, versioned campus fields or guides to a known section. */
export function findAssistantGuide(
  question: string,
  sources: CanonSource[],
  cards: KnowledgeCard[] = []
): AssistantGuide | null {
  question = assistantQuestion(question);
  let words = wordsFor(question);
  if (words.some((word) => qualifiers.test(word))) return null;
  const navigation = navigationGuide(words, sources);
  if (navigation) return navigation;
  const normalized = normalizeKnowledgeText(question);
  const specific = equipmentPlacementGuide(normalized, sources, cards) ??
    approvedCardList(normalized, sources, cards) ?? projectOverview(normalized, sources);
  if (specific) return specific;

  const scopeWords = ["кампус", "паспорт", "унк"];
  let campusSources = sources.filter(({ type }) => type === "campus");
  const named = campusSources.flatMap((source) => {
    const name = wordsFor(source.title.match(/«([^»]+)»/u)?.[1] ?? "");
    const start = name.length
      ? words.findIndex((_, index) =>
          name.every((word, offset) =>
            sameKnowledgeWord(word, words[index + offset] ?? "")
          )
        )
      : -1;
    return start >= 0 ? [{ source, start, length: name.length }] : [];
  });
  if (named.length === 1) {
    const [{ source, start, length }] = named;
    campusSources = [source];
    words = [...words.slice(0, start), ...words.slice(start + length)];
  }
  if (words.some((word) => /^кампус(?:ы|ов|ам|ами|ах)$/u.test(word)))
    return null;
  const requestedPhases = hotelPhaseRequest(words);
  if (requestedPhases.length)
    return campusSources.length === 1 ? hotelPhaseAnswer(campusSources[0], requestedPhases) : null;
  const singularCampus = words.some((word) =>
    /^кампус(?:а|у|ом|е)?$/u.test(word)
  );
  const areaQuestion = singularCampus && words.includes("площадь");
  const squareMetres = /(?<!\S)в квадратных метрах(?!\S)/u;
  const areaInSquareMetres = areaQuestion && squareMetres.test(words.join(" "));
  const subjectWords = areaQuestion
    ? words
        .join(" ")
        .replace(
          /(?<!\S)(?:у )?(?:межуниверситетск[а-я]* )?(кампус(?:а|у|ом|е)?)(?!\S)/gu,
          "$1"
        )
        .replace(squareMetres, "")
        .split(/\s+/u)
        .filter(Boolean)
    : words;
  // Campus and passport can describe the source rather than the metric; УНК
  // is a factual constraint and must remain in the quoted field itself.
  const subject = subjectWords.filter(
    (word) => !questionWords.has(word) && !has(["кампус", "паспорт"], word)
  );
  const hasCampusScope = scopeWords.some((word) => has(words, word));
  const namedApartments =
    words.includes("сколько") &&
    subject.length === 2 &&
    has(subject, "апартаменты") &&
    has(subject, "а5");
  if (!hasCampusScope && !namedApartments) return null;
  if (!subject.length || subject.every((word) => word === "унк")) return null;

  const membership =
    has(subject, "университет") &&
    (subject.length === 1 || has(subject, "состав"));
  const requestsList = tokenizeKnowledgeText(question).some((word) =>
    /^(?:какие|каких|состав)$/u.test(word)
  );
  const generalArea =
    areaQuestion && subject.every((word) => has(["площадь", "общая"], word));
  const residence =
    singularCampus &&
    words.includes("сколько") &&
    subject.some((word) => /^мест(?:а)?$/u.test(word)) &&
    subject.every((word) =>
      /^(?:мест(?:а)?|проживани[яе]|гостиниц(?:ах|е)?)$/u.test(word)
    );
  if (
    isCampusStatisticQuestion(question) &&
    subject.some((word) => /^(?:19|20)\d{2}$/u.test(word))
  )
    return null;

  const matches = campusSources
    .flatMap((source) =>
      source.facts.flatMap((fact) => {
        const metric = fact.field.startsWith("campusMetrics.");
        if (
          fact.text.length > 1200 ||
          !(
            metric ||
            (generalArea && fact.field.startsWith("verifiedFacts.")) ||
            (membership && fact.field === "referenceDescription")
          )
        )
          return [];
        if (
          generalArea &&
          !/^общая площадь(?: объектов| кампуса)?$/iu.test(fact.label)
        )
          return [];
        if (!hasCampusScope && fact.label !== "Апартаменты А5") return [];
        const valueText = fact.text.split(" (", 1)[0];
        if (
          generalArea &&
          areaInSquareMetres &&
          !/(?<![\p{L}\p{N}])(?:м[²2]|кв\.\s*м)(?![\p{L}\p{N}])/iu.test(
            valueText
          )
        )
          return [];
        if (membership && requestsList && !words.includes("сколько") && metric)
          return [];
        if (fact.label === "Апартаменты А5" && !has(subject, "а5")) return [];
        const totalResidence =
          residence && fact.label === "Общая вместимость гостиниц";
        if (!totalResidence && !matchesAssertion(fact, subject))
          return [];
        // A value or label is a better match than a passing mention in a metric note.
        const value = wordsFor(valueText);
        const label = wordsFor(fact.label);
        const rank = subject.reduce(
          (score, word) =>
            score + Number(has(value, word)) + 2 * Number(has(label, word)),
          totalResidence ? 10 : 0
        );
        return [{ sourceId: source.id, factId: fact.id, rank }];
      })
    )
    .sort((left, right) => right.rank - left.rank);
  if (!hasCampusScope && matches.length !== 1) return null;
  const best = matches[0];
  if (!best || best.rank === matches[1]?.rank) {
    if (
      !best &&
      generalArea &&
      campusSources.length === 1 &&
      !campusSources[0].facts.some(
        (fact) =>
          /площад[ьи]/iu.test(fact.label) ||
          (fact.field === "referenceDescription" &&
            /(?:общая|совокупная)\s+площадь/iu.test(fact.text))
      )
    ) {
      return {
        message:
          "Общая площадь кампуса не указана в текущем утверждённом паспорте.",
        citations: [],
        actions: [
          {
            label: "Паспорт кампуса · версия источника",
            href: campusSources[0].href,
          },
        ],
      };
    }
    // A count alone cannot answer which institutions are members. Offer the
    // resident section without inventing a list or dropping an extra constraint.
    if (
      membership &&
      requestsList &&
      singularCampus &&
      !words.includes("сколько") &&
      subject.every((word) => has(["университет", "состав"], word))
    )
      return {
        message:
          "Откройте раздел «Вузы-резиденты», чтобы найти утверждённые карточки.",
        citations: [],
        actions: [
          {
            label: "Вузы-резиденты",
            href: `/knowledge?folder=${encodeURIComponent(folderIds.universities)}`,
          },
        ],
      };
    return null;
  }
  const citation = resolveCanonReference(best, sources);
  if (!citation) return null;
  const message = assistantFactSummary(citation);
  return {
    message:
      message ??
      "В утверждённой карточке есть сведения по вопросу. Ниже приведено поле источника целиком.",
    citations: [citation],
    actions: [],
    ...(message && { presentation: "summary" }),
  };
}
