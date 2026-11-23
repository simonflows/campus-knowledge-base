import { claimSpan, type ClaimSpan } from "./fact-claims";

export const SEMANTIC_BATCH_LIMIT = 32;
export const SEMANTIC_OUTPUT_TOKENS = 3000;
export const SEMANTIC_DEADLINE_MS = 48_000;
export const SEMANTIC_STREAM_DEADLINE_MS = 180_000;

const batchChars = 3000;
const batchSpanLimit = 24;
const contextChars = 320;
const callDeadlineMs = 22_000;
const streamedCallDeadlineMs = 32_000;
const maxInputChars = 70_000;
const maxTotalInputChars = 1_600_000;
const meaningful = /[\p{L}\p{N}]/u;

type FramedSpan = ClaimSpan & { frameStart?: number; frameEnd?: number };
export type SemanticSpan = FramedSpan & { id: number };
export type SemanticBatch = { spans: SemanticSpan[]; input: string };

export function fitsSemanticInputBudget(batches: SemanticBatch[]) {
  return batches.every(batch => batch.input.length <= maxInputChars) &&
    batches.reduce((sum, batch) => sum + batch.input.length, 0) <= maxTotalInputChars;
}

function boundedSpans(text: string, original: FramedSpan[]) {
  const spans: SemanticSpan[] = [];
  for (const span of original) {
    let start = span.quoteStart;
    while (start < span.quoteEnd) {
      let end = Math.min(start + batchChars, span.quoteEnd);
      if (end < span.quoteEnd) {
        const lastBreak = /\s\S*$/u.exec(text.slice(start, end));
        if (lastBreak && lastBreak.index >= batchChars / 2) {
          end = start + lastBreak.index;
        } else if (/[\uDC00-\uDFFF]/u.test(text[end])) {
          end--;
        }
      }
      const part = claimSpan(text, start, end);
      if (meaningful.test(part.quote)) spans.push({
        ...part, id: spans.length + 1, frameStart: span.frameStart, frameEnd: span.frameEnd,
      });
      start = end;
    }
  }
  return spans;
}

/** The target spans partition the article. Adjacent context is read-only. */
export function semanticBatches(
  text: string, original: FramedSpan[], sources: readonly unknown[], stage?: "extract"
) {
  return groupSemanticSpans(text, boundedSpans(text, original), sources, original[0]?.quote, stage);
}

export function recoverSemanticSpans(
  text: string, spans: SemanticSpan[], sources: readonly unknown[], heading?: string
) {
  return groupSemanticSpans(text, spans, sources, heading, "extract", true);
}

function groupSemanticSpans(
  text: string, spans: SemanticSpan[], sources: readonly unknown[], title?: string,
  stage?: "extract", sparse = false
) {
  const groups: SemanticSpan[][] = [];
  let group: SemanticSpan[] = [];
  let chars = 0;
  for (const span of spans) {
    if (group.length >= batchSpanLimit || chars + span.quote.length > batchChars) {
      groups.push(group);
      if (groups.length >= SEMANTIC_BATCH_LIMIT) return null;
      group = [];
      chars = 0;
    }
    group.push(span);
    chars += span.quote.length;
  }
  if (group.length) groups.push(group);
  if (!groups.length) return null;
  const heading = title?.slice(0, contextChars);
  const sourceJson = JSON.stringify(sources);
  let inputChars = 0;
  const batches: SemanticBatch[] = [];
  for (const target of groups) {
    const start = target[0].quoteStart;
    const end = target[target.length - 1].quoteEnd;
    const contextBefore = text.slice(Math.max(0, start - contextChars), start).trim();
    const contextAfter = text.slice(end, end + contextChars).trim();
    const claims = target.map(({ id, quote, quoteStart, quoteEnd }, index) => {
      const before = sparse ? text.slice(Math.max(0, quoteStart - contextChars), quoteStart).trim()
        : index ? text.slice(target[index - 1].quoteEnd, quoteStart).trim() : contextBefore;
      const after = sparse ? text.slice(quoteEnd, quoteEnd + contextChars).trim() : "";
      return { id, text: quote, ...(before && { contextBefore: before }), ...(after && { contextAfter: after }) };
    });
    const context = JSON.stringify({ stage, heading, contextAfter, claims });
    const input = '{"sources":' + sourceJson + ',' + context.slice(1);
    inputChars += input.length;
    if (input.length > maxInputChars || inputChars > maxTotalInputChars) return null;
    batches.push({ spans: target, input });
  }
  return { spans, batches };
}

export type SemanticBatchResult<T> =
  | { status: "ready"; output: T }
  | { status: "unavailable" | "busy" | "failed" | "too-long" };

async function withDeadline<T>(
  signal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<SemanticBatchResult<T>>,
  timeoutMs: number
): Promise<SemanticBatchResult<T>> {
  if (signal.aborted) return { status: "failed" };
  const callSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let stop = () => {};
  const cancelled = new Promise<SemanticBatchResult<T>>(resolve => {
    stop = () => resolve({ status: "failed" });
    callSignal.addEventListener("abort", stop, { once: true });
  });
  try {
    return await Promise.race([operation(callSignal), cancelled]);
  } catch {
    return { status: "failed" };
  } finally {
    callSignal.removeEventListener("abort", stop);
  }
}

/** One account job attempts at most two batches at a time, with no retries. */
export async function runSemanticBatches<T>(
  batches: SemanticBatch[],
  signal: AbortSignal,
  ask: (batch: SemanticBatch, signal: AbortSignal) => Promise<SemanticBatchResult<T>>,
  options: { streaming?: boolean; onSettled?: (completed: number) => void } = {}
) {
  const responses = new Map<number, SemanticBatchResult<T>>();
  let next = 0;
  let halt = false;
  const worker = async () => {
    while (!halt && !signal.aborted && next < batches.length) {
      const index = next++;
      const response = await withDeadline(
        signal, callSignal => ask(batches[index], callSignal),
        options.streaming ? streamedCallDeadlineMs : callDeadlineMs
      );
      responses.set(index, response);
      if (!signal.aborted) options.onSettled?.(responses.size);
      if (response.status === "unavailable" || response.status === "busy") halt = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, batches.length) }, worker));
  return responses;
}
