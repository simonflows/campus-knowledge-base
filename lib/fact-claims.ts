export type ClaimVerdict = "supported" | "contradicted" | "unknown" | "opinion" | "outside";

export type ClaimSpan = {
  quote: string;
  quoteStart: number;
  quoteEnd: number;
};

export type FactClaim = ClaimSpan & { id: string; verdict: ClaimVerdict };
export type ClaimCoverage = Record<ClaimVerdict, number> & {
  mode: "limited" | "semantic" | "mixed";
  semanticReviewed?: number;
  spanCount?: number;
};

export function claimCoverage(claims: FactClaim[], mode: ClaimCoverage["mode"]): ClaimCoverage {
  const coverage = { mode, supported: 0, contradicted: 0, unknown: 0, opinion: 0, outside: 0 };
  for (const claim of claims) coverage[claim.verdict]++;
  return coverage;
}

export function claimSpan(text: string, start: number, end: number): ClaimSpan {
  const original = text.slice(start, end);
  const quote = original.trim();
  const quoteStart = start + original.length - original.trimStart().length;
  return { quote, quoteStart, quoteEnd: quoteStart + quote.length };
}

export function makeClaim(span: ClaimSpan, verdict: ClaimVerdict): FactClaim {
  return { ...span, id: "claim-" + span.quoteStart + "-" + span.quoteEnd, verdict };
}

export const interviewTopic = /\s+[—–]\s+(?=(?:о|об|обо|про)\s)/iu;
const question = /[?？][»”"')\s]*$/u;
const questionStart = /^(?:кто|что|где|когда|как(?:ой|ая|ое|ие|ого|ому|ую|их|им|ими)?|зачем|почему|в\s+ч[её]м|сколько)(?![\p{L}])/iu;
const topicStart = /^(?:о|об|обо|про)\s+/iu;
const subjective = /^(?:(?:мне|нам)\s+кажется|(?:я|мы)\s+(?:думаю|думаем|считаю|считаем|уверен[аы]?)|по\s+(?:моему|нашему)\s+мнению)(?![\p{L}])|(?:станов\p{L}*|выгляд\p{L}*|каж\p{L}*)\s+(?:куда\s+)?(?:привлекательнее|красивее|интереснее|лучше|уютнее|скучнее)|(?:поколени\p{L}*|молод[её]ж\p{L}*).{0,60}(?:чувств\p{L}*\s+ложь|чувств\p{L}*\s+лжи)/iu;
const presupposition = /^(?:почему|как|зачем|когда)\s+.*(?:увеличи\p{L}*|сократи\p{L}*|выигра\p{L}*|победи\p{L}*|получи\p{L}*|откры\p{L}*|строи\p{L}*|составля\p{L}*|достиг\p{L}*|находит(?:ся)?|расположен[аоы]?)/iu;
const metaphor = /\s+[—–]\s+(?:сердце|душа)\s+(?:города|региона|области|образования|науки)(?!\p{L})/iu;
const evaluation = /^(?:мне|нам)\s+нрави(?:тся|лись|лось)(?!\p{L})|\s+[—–]\s+(?:(?:очень|особенно)\s+)?(?:приятн|уютн|красив|замечательн|прекрасн|скучн)\p{L}*\s+(?:место|город|район)(?!\p{L})/iu;
const factualPredicate =
  /(?<!\p{L})(?:готов[аоы]?|установлен[аоы]?|заверш[её]н[аоы]?|расположен[аоы]?|находи\p{L}*|составля\p{L}*|лечит|лечат|вылечи\p{L}*|работае\p{L}*|действуе\p{L}*|возглавля\p{L}*|руководи\p{L}*|назначен[аоы]?)(?!\p{L})/iu;
const assertedPlace =
  /(?<!\p{L})(?:в|на)\s+(?:[А-ЯЁ][а-яё]{2,}(?!\p{L})|(?:\p{L}+\s+){0,2}(?:территории|площадке|этаже|корпусе))(?!\p{L})/u;
const opinionQualifier =
  /^\s*(?:[—–-]\s+)?[«„“"]?(?:(?:мне|нам)\s+кажется|(?:я|мы)\s+(?:думаю|думаем|считаю|считаем)|по\s+(?:моему|нашему)\s+мнению)\s*,\s*(?:что\s+)?/iu;

export function concreteClaimForm(text: string): boolean {
  return /\p{N}/u.test(text) || factualPredicate.test(text) || assertedPlace.test(text) ||
    /^(?:ректор|проректор)\s+\S+\s+\S/iu.test(text);
}

const assertionQualification = /(?:^|[^\p{L}])(?:если|при\s+условии|в\s+случае|гипотез[а-яё]*|гипотетическ[а-яё]*|предполож[а-яё]*|неверн[а-яё]*|ошибочн[а-яё]*|опроверг[а-яё]*|недостоверн[а-яё]*|ложн[а-яё]*|не\s+соответствует|не\s+подтвержден[а-яё]*|нельзя\s+утверждать|планиру[а-яё]*|ранее|раньше|(?:в|с|до|после|к|на|за)\s+(?:19|20|21)\d{2})(?![\p{L}\p{N}])/iu;
const independentClause = /;\s*|,\s+а\s+(?!(?:это|так|на\s+самом\s+деле)(?!\p{L}))/iu;

/** A verbatim substring may omit the words that qualify or deny it. */
export function omitsAssertionQualification(before: string, after: string) {
  const prefix = before.split(independentClause).at(-1) ?? "";
  const suffix = after.split(independentClause, 1)[0] ?? "";
  return assertionQualification.test(prefix + " " + suffix) ||
    /(?:^|[^\p{L}])не\s*[«„“"]?\s*$/iu.test(prefix) ||
    /^\s*[»”"]?\s*[,—–-]?\s*это\s+не\s+так/iu.test(suffix);
}

/** A speaker's hedging does not remove the numerical or operational claim it qualifies. */
export function opinionQualifierEnd(text: string): number {
  const end = opinionQualifier.exec(text)?.[0].length ?? 0;
  if (!end) return 0;
  const claim = text.slice(end);
  return !nonFactualForm(claim) &&
    (factualPredicate.test(claim) || /\d+\s*(?:тыс|млн|млрд|кв\.?|руб|метр|программ|решени|человек|студент|мест|%)/iu.test(claim))
    ? end
    : 0;
}

export function opinionAssertionRemainder(text: string): string {
  const length = opinionQualifier.exec(text)?.[0].length ?? 0;
  return length ? text.slice(length) : "";
}

/** Identify non-assertive forms without interpreting an article as instructions. */
export function nonFactualForm(text: string): "opinion" | "outside" | undefined {
  const content = text.replace(/^(?:#{1,6}\s+)?(?:[—–-]\s+)?[«“"]?\s*/u, "");
  if ((question.test(content) || questionStart.test(content)) && !presupposition.test(content)) return "outside";
  if (subjective.test(content) || metaphor.test(content) || evaluation.test(content)) return "opinion";
  if (topicStart.test(content)) return "outside";
}
