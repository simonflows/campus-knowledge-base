export class JsonBodyError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "JsonBodyError"; }
}

/** Bound streamed bodies as well as Content-Length; never log user input. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) throw new JsonBodyError("Запрос слишком большой", 413);
  if (!request.body) throw new JsonBodyError("Пустой запрос", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) { await reader.cancel(); throw new JsonBodyError("Запрос слишком большой", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new JsonBodyError("Некорректный JSON в запросе", 400); }
  } finally { reader.releaseLock(); }
}
