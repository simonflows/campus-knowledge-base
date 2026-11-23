import type { FactCheckProgress } from "./fact-check-progress";

export class FactCheckResponseError extends Error {}

const incomplete = () =>
  new FactCheckResponseError(
    "Проверка не завершена. Повторите запрос или проверьте текст частями."
  );
const invalid = () =>
  new FactCheckResponseError(
    "Некорректный ответ сервиса проверки. Повторите запрос."
  );
const maxBytes = 16 * 1024 * 1024;

/** Accept legacy JSON or the explicit progress protocol. EOF alone is never success. */
export async function readFactCheckResponse(
  response: Response,
  onProgress?: (progress: FactCheckProgress) => void,
  signal?: AbortSignal
): Promise<unknown> {
  if (!response.headers.get("Content-Type")?.includes("application/x-ndjson")) {
    return response.json();
  }
  if (!response.body) throw incomplete();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bytes = 0;
  let records = 0;
  let terminal = false;
  let finished = false;
  let result: unknown;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const abortCheck = () => {
    if (signal?.aborted)
      throw new DOMException("Проверка отменена", "AbortError");
  };
  const record = (line: string) => {
    if (!line.trim()) return;
    if (++records > 256 || terminal) throw invalid();
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw invalid();
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw invalid();
    const item = value as Record<string, unknown>;
    if (item.type === "heartbeat") return;
    if (item.type === "progress") {
      const { stage, completed, total } = item;
      if (
        (stage !== "extract" && stage !== "verify") ||
        typeof completed !== "number" ||
        !Number.isSafeInteger(completed) ||
        completed < 0 ||
        typeof total !== "number" ||
        !Number.isSafeInteger(total) ||
        total < completed
      )
        throw invalid();
      onProgress?.({ stage, completed, total });
      return;
    }
    if (item.type === "error") {
      throw new FactCheckResponseError(
        typeof item.error === "string" && item.error.length <= 1000
          ? item.error
          : "Сервис не завершил проверку. Повторите запрос."
      );
    }
    if (
      item.type !== "result" ||
      !item.result ||
      typeof item.result !== "object" ||
      Array.isArray(item.result)
    )
      throw invalid();
    result = item.result;
    terminal = true;
  };
  try {
    abortCheck();
    while (true) {
      const { done, value } = await reader.read();
      abortCheck();
      if (done) {
        finished = true;
        buffer += decoder.decode();
        if (buffer.trim()) record(buffer);
        if (!terminal) throw incomplete();
        return result;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) throw invalid();
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        record(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
