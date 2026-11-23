import {
  resolveCanonReference,
  type CanonCitation,
  type CanonFact,
  type CanonSource,
} from "./canon-context";
import { campusServices } from "./campus-services";
import { folderIds } from "./knowledge";
import { sameKnowledgeWord, tokenizeKnowledgeText } from "./knowledge-query";

type AssistantGuide = {
  message: string;
  citations: CanonCitation[];
  actions: { label: string; href: string }[];
};

const questionWords = new Set(
  "а в во для из к на о об по про с со как какова каков какой какого какая какое какие каких где сколько что кто ли можно пожалуйста подскажите скажите расскажите указано указаны предусмотрено предусмотрены".split(
    " "
  )
);
const navigationVerbs =
  /^(?:откр|найт|иск|перейт|посмотр|провер|подготов|созда|напис|сдела|войти)/u;
const qualifiers = /^(?:не|ни|без|кроме|исключая)$/u;
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
  sources: CanonSource[]
): AssistantGuide | null {
  const words = wordsFor(question);
  if (words.some((word) => qualifiers.test(word))) return null;
  const navigation = navigationGuide(words, sources);
  if (navigation) return navigation;

  const scopeWords = ["кампус", "паспорт", "унк"];
  if (!scopeWords.some((word) => has(words, word))) return null;
  // Campus and passport can describe the source rather than the metric; УНК
  // is a factual constraint and must remain in the quoted field itself.
  const subject = words.filter(
    (word) => !questionWords.has(word) && !has(["кампус", "паспорт"], word)
  );
  if (!subject.length || subject.every((word) => word === "унк")) return null;

  const membership =
    has(subject, "университет") &&
    (subject.length === 1 || has(subject, "состав"));
  const matches = sources
    .filter(({ type }) => type === "campus")
    .flatMap((source) =>
      source.facts.flatMap((fact) => {
        const metric = fact.field.startsWith("campusMetrics.");
        if (
          fact.text.length > 1200 ||
          !(metric || (membership && fact.field === "referenceDescription"))
        )
          return [];
        if (!matchesAssertion(fact, subject)) return [];
        // A value or label is a better match than a passing mention in a metric note.
        const value = wordsFor(fact.text.split(" (", 1)[0]);
        const label = wordsFor(fact.label);
        const rank = subject.reduce(
          (score, word) =>
            score + Number(has(value, word)) + 2 * Number(has(label, word)),
          0
        );
        return [{ sourceId: source.id, factId: fact.id, rank }];
      })
    )
    .sort((left, right) => right.rank - left.rank);
  const best = matches[0];
  if (!best || best.rank === matches[1]?.rank) {
    // A count alone cannot answer which institutions are members. Offer the
    // resident section without inventing a list or dropping an extra constraint.
    const requestsList = tokenizeKnowledgeText(question).some(word => /^(?:какие|каких|состав)$/u.test(word));
    const singularCampus = words.some(word => /^кампус(?:а|у|ом|е)?$/u.test(word));
    if (membership && requestsList && singularCampus && !words.includes("сколько") &&
        subject.every(word => has(["университет", "состав"], word)))
      return {
        message: "Откройте раздел «Вузы-резиденты», чтобы найти утверждённые карточки.",
        citations: [],
        actions: [{ label: "Вузы-резиденты", href: `/knowledge?folder=${encodeURIComponent(folderIds.universities)}` }],
      };
    return null;
  }
  const citation = resolveCanonReference(best, sources);
  if (!citation) return null;
  return {
    message:
      "В утверждённой карточке есть сведения по вопросу. Ниже приведено поле источника целиком.",
    citations: [citation],
    actions: [],
  };
}
