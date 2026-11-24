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
        (word === "университет" &&
          words.some((cue) => cue === "какие" || cue === "состав"))
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
  question = assistantQuestion(question);
  let words = wordsFor(question);
  if (words.some((word) => qualifiers.test(word))) return null;
  const navigation = navigationGuide(words, sources);
  if (navigation) return navigation;

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
  const phase =
    singularCampus &&
    words.includes("сколько") &&
    subject.join(" ").match(/^мест(?:а)? (первой|второй) очереди гостиниц$/u);
  const phaseLabel =
    phase &&
    (phase[1] === "первой"
      ? "Первая очередь гостиниц"
      : "Вторая очередь гостиниц");
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
          phaseLabel &&
          (!metric ||
            fact.label !== phaseLabel ||
            !/\d\s+мест(?:а|о)?(?![\p{L}\p{N}])/u.test(valueText))
        )
          return [];
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
        if (!totalResidence && !phaseLabel && !matchesAssertion(fact, subject))
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
