const cyrillic = /^[а-я]+$/u;
const latin = /^[a-z]+$/u;
const numberedIdentifier = /^\p{L}[\p{L}\p{N}-]*\d[\p{L}\p{N}-]*$/u;
const russianEnding =
  /(?:иями|ями|ами|ого|ему|ому|ыми|ими|иях|ах|ях|ую|юю|ая|яя|ое|ее|ый|ий|ым|им|ых|их|ой|ом|ем|ам|ям|ов|ев|ей|а|я|ы|и|у|ю|е|о)$/u;
const transliteration: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

export function normalizeKnowledgeText(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replaceAll("ё", "е")
    .replace(/[‐‑]/gu, "-")
    .replace(/(?<=\d)[ \u00a0\u202f]+(?=\d{3}(?:[.,]\d|[^\d]|$))/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function withoutSourceUrls(text: string): string {
  return text.replace(/(?:https?:\/\/|\bwww\.)[^\s<>«»"')\]}]+/giu, " ").trim();
}

function tokens(text: string) {
  return [
    ...normalizeKnowledgeText(text).matchAll(
      /[a-z][a-z0-9]*(?:-[a-z0-9]+)+(?![\p{L}\p{N}-])|\p{L}[\p{L}\p{N}]*(?:-\d+[\p{L}\p{N}]*)*|\d+(?:[.,]\d+)?[\p{L}]*/gu
    ),
  ].map((match) => ({ word: match[0], index: match.index }));
}

export function tokenizeKnowledgeText(text: string): string[] {
  return tokens(text).map(({ word }) => word);
}

function stem(word: string) {
  const root = word.replace(russianEnding, "");
  return root.length >= 4 ? root : word;
}

function crossScriptMatch(english: string, russian: string) {
  return (
    english.length >= 4 &&
    russian.length >= 4 &&
    english.replace(/c(?=[aou]|$)/gu, "k") === transliterate(russian)
  );
}

function transliterate(text: string) {
  return Array.from(text, (letter) => transliteration[letter] ?? letter).join(
    ""
  );
}

export function sameKnowledgeWord(first: string, second: string): boolean {
  if (first === second) return true;
  if (numberedIdentifier.test(first) && numberedIdentifier.test(second)) {
    return transliterate(first) === transliterate(second);
  }
  if (cyrillic.test(first) && cyrillic.test(second))
    return stem(first) === stem(second);
  if (latin.test(first) && cyrillic.test(second))
    return crossScriptMatch(first, second);
  return (
    latin.test(second) &&
    cyrillic.test(first) &&
    crossScriptMatch(second, first)
  );
}

/** Quoted query phrases stay together. Unquoted words can match different fields of a card. */
export function knowledgeQueryTerms(query: string): string[][] {
  return [...query.matchAll(/[«"“]([^»"”]+)[»"”]|[^\s«»"“”]+/gu)]
    .flatMap((match) =>
      match[1]
        ? [tokenizeKnowledgeText(match[1])]
        : tokenizeKnowledgeText(match[0]).map((word) => [word])
    )
    .filter((term) => term.length > 0);
}

export function indexKnowledgeFragment(text: string) {
  return { text, words: tokens(text) };
}

export function matchKnowledgeTerm(
  fragment: ReturnType<typeof indexKnowledgeFragment>,
  term: string[]
): number {
  const start = fragment.words.findIndex((_, index) =>
    term.every((word, offset) =>
      sameKnowledgeWord(fragment.words[index + offset]?.word ?? "", word)
    )
  );
  return start < 0 ? -1 : fragment.words[start].index;
}
