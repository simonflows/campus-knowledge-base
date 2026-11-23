import type { FactCheckProgress } from "./fact-check-progress";

const ndjson = "application/x-ndjson";
const heartbeatMs = 10_000;

export type FactCheckRunResult<T> =
  | { ok: true; result: T }
  | { ok: false; error: string; status: number };

export function acceptsFactCheckStream(request: Request): boolean {
  return request.headers.get("accept")?.split(",").some(value => {
    const [media, ...parameters] = value.toLowerCase().split(";").map(part => part.trim());
    return media === ndjson && !parameters.some(parameter => /^q\s*=\s*0(?:\.0*)?$/u.test(parameter));
  }) ?? false;
}

export function streamFactCheck<T>(
  request: Request,
  run: (request: Request, progress: (value: FactCheckProgress) => void) => Promise<FactCheckRunResult<T>>
): Response {
  const disconnect = new AbortController();
  const signal = AbortSignal.any([request.signal, disconnect.signal]);
  const scoped = new Request(request.url, { method: request.method, headers: request.headers, signal });
  const encoder = new TextEncoder();
  let closed = false;
  let cleanup = () => {};

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (record: object) => {
        if (!closed && !signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(record) + "\n"));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.close();
      };
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener("abort", finish, { once: true });
      const ticker = setInterval(() => emit({ type: "heartbeat" }), heartbeatMs);
      cleanup = () => {
        clearInterval(ticker);
        signal.removeEventListener("abort", finish);
      };
      emit({ type: "heartbeat" });
      void Promise.resolve()
        .then(() => run(scoped, progress => emit({ type: "progress", ...progress })))
        .then(outcome => {
          if (outcome.ok) emit({ type: "result", result: outcome.result });
          else emit({ type: "error", error: outcome.error, status: outcome.status });
        })
        .catch(() => emit({
          type: "error", error: "Не удалось завершить смысловую проверку.", status: 500,
        }))
        .finally(finish);
    },
    cancel() {
      closed = true;
      cleanup();
      disconnect.abort();
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": ndjson + "; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Accel-Buffering": "no",
      Vary: "Accept",
    },
  });
}
