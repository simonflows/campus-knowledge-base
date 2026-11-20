/** Return a replacement only for one exact, unchanged source span. Never replace all. */
export function replaceCheckedFragment(
  text: string,
  quote: string,
  replacement: string,
  quoteStart?: number,
  quoteEnd?: number
): string | null {
  if (!quote || !replacement.trim()) return null;
  const start = quoteStart ?? text.indexOf(quote);
  const end = quoteEnd ?? start + quote.length;
  if (start < 0 || text.slice(start, end) !== quote) return null;
  if (quoteStart == null && text.indexOf(quote, start + quote.length) !== -1)
    return null;
  return text.slice(0, start) + replacement + text.slice(end);
}
