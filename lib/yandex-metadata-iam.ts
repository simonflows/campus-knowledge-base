import { TextDecoder } from "node:util";
import { z } from "zod";

const metadataEndpoint = "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token";
const metadataSchema = z.object({
  access_token: z.string().min(1).max(8192).regex(/^\S+$/u),
  expires_in: z.number().int().positive().max(86_400),
  token_type: z.literal("Bearer").optional(),
});

export async function readYandexJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Missing response body");
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    void response.body.cancel().catch(() => {});
    throw new Error("Response too large");
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let content = "";
  let finished = false;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        finished = true;
        return JSON.parse(content + decoder.decode()) as unknown;
      }
      size += value.byteLength;
      if (size > limit) throw new Error("Response too large");
      content += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!finished) cancel();
    reader.releaseLock();
  }
}

export function createMetadataIamToken(fetcher: typeof fetch, now: () => number = Date.now) {
  let cached: { token: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;

  async function requestToken() {
    const startedAt = now();
    const signal = AbortSignal.timeout(3000);
    const response = await fetcher(metadataEndpoint, {
      headers: { "Metadata-Flavor": "Google" }, cache: "no-store", redirect: "error", signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new Error("Metadata authentication unavailable");
    }
    const result = metadataSchema.safeParse(await readYandexJson(response, 16_384, signal));
    if (!result.success) throw new Error("Invalid metadata authentication response");
    const expiresAt = startedAt + result.data.expires_in * 1000;
    if (expiresAt <= now()) throw new Error("Metadata authentication expired");
    cached = { token: result.data.access_token, expiresAt };
    return cached.token;
  }

  return async function getMetadataIamToken(): Promise<string> {
    if (cached && cached.expiresAt > now() + 60_000) return cached.token;
    refreshing ??= requestToken().finally(() => { refreshing = undefined; });
    return refreshing;
  };
}

export const getMetadataIamToken = createMetadataIamToken((...args) => fetch(...args));
