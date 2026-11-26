import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { consumeAiBudget } from "./ai-budget";
import { getMetadataIamToken, readYandexJson } from "./yandex-metadata-iam";

type ExternalSource = { id: string; title: string; url: string };
export type WebSearchAnswer = {
  status: "ready" | "unavailable" | "busy" | "failed";
  mode: "web";
  message: string;
  citations: [];
  actions: [];
  externalSources: ExternalSource[];
};

type WebSearchInput = { request: Request; accountId: string; question: string };
type WebChatSettings = {
  env: Readonly<Partial<NodeJS.ProcessEnv>>;
  fetcher: typeof fetch;
  budget: typeof consumeAiBudget;
  getMetadataToken(): Promise<string>;
  now?: () => number;
  timeoutSignal?: () => AbortSignal;
};

const endpoint = "https://searchapi.api.cloud.yandex.net/v2/gen/search";
const maxResponseBytes = 1024 * 1024;
const maxAnswerLength = 3500;
const maxSources = 8;
const cooldownMs = 10_000;

const answerSchema = z.object({
  message: z.object({ content: z.string().min(1).max(16_384), role: z.literal("ROLE_ASSISTANT") }),
  sources: z.array(z.unknown()).min(1).max(100),
  isAnswerRejected: z.boolean().optional(),
  problematicAnswer: z.boolean().optional(),
});
const sourceSchema = z.object({
  url: z.string().trim().min(1).max(2048),
  title: z.string().max(4096),
  used: z.literal(true),
});

function result(status: WebSearchAnswer["status"], message: string, externalSources: ExternalSource[] = []): WebSearchAnswer {
  return { status, mode: "web", message, citations: [], actions: [], externalSources };
}

function plainText(value: string, limit: number) {
  const text = value
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, "")
    .replace(/<[^<>]*>/gu, "")
    .replace(/!?\[([^\]\r\n]+)\]\([^\r\n]*?\)/gu, "$1")
    .replace(/\[\d{1,3}\]/gu, "")
    .replace(/\*\*|__|`/gu, "")
    .replace(/[^\S\r\n]+/gu, " ")
    .trim();
  if (text.length <= limit) return text;
  const shortened = text.slice(0, limit - 1).trimEnd();
  return shortened + "…";
}

const nonPublicSuffix = /(?:^|\.)(?:localhost|localdomain|local|lan|home|corp|internal|intranet|private|onion|invalid|test|example|arpa)$/u;
function externalUrl(value: string): string | null {
  if (!/^https?:\/\//iu.test(value)) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/\.$/u, "");
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password ||
        !hostname.includes(".") || isIP(hostname) || nonPublicSuffix.test(hostname)) return null;
    url.hostname = hostname;
    return url.href.length <= 2048 ? url.href : null;
  } catch {
    return null;
  }
}

function parseAnswer(body: unknown): WebSearchAnswer {
  // The REST reference describes an object and the official operation's example wraps it in an array.
  const payload = Array.isArray(body) && body.length === 1 ? body[0] : body;
  const parsed = answerSchema.safeParse(payload);
  if (!parsed.success || parsed.data.isAnswerRejected || parsed.data.problematicAnswer)
    return result("failed", "Внешний поиск не сформировал ответ с источниками. Попробуйте уточнить вопрос.");

  const sources = new Map<string, ExternalSource>();
  for (const candidate of parsed.data.sources) {
    const parsedSource = sourceSchema.safeParse(candidate);
    if (!parsedSource.success) continue;
    const url = externalUrl(parsedSource.data.url);
    const title = plainText(parsedSource.data.title, 200);
    if (!url || !title || sources.has(url)) continue;
    const id = "web-" + createHash("sha256").update(url).digest("hex").slice(0, 16);
    sources.set(url, { id, title, url });
    if (sources.size === maxSources) break;
  }
  const message = plainText(parsed.data.message.content, maxAnswerLength);
  if (!message || !sources.size)
    return result("failed", "Внешний поиск не сформировал ответ с источниками. Попробуйте уточнить вопрос.");
  return result("ready", message, [...sources.values()]);
}

export function createWebChat({ env, fetcher, budget, getMetadataToken, now = Date.now,
  timeoutSignal = () => AbortSignal.timeout(45_000) }: WebChatSettings) {
  const lastAttempt = new Map<string, number>();
  let active = 0;

  return async function answerWebChat({ request, accountId, question }: WebSearchInput): Promise<WebSearchAnswer> {
    const folderId = env.CAMPUS_WEB_SEARCH_FOLDER_ID?.trim() || env.YANDEX_AI_STUDIO_FOLDER_ID?.trim();
    const apiKey = env.CAMPUS_WEB_SEARCH_API_KEY?.trim();
    const metadata = env.CAMPUS_WEB_SEARCH_USE_METADATA === "true";
    if (env.CAMPUS_WEB_SEARCH_ENABLED !== "true" || !folderId || folderId.length > 50 || (!apiKey && !metadata))
      return result("unavailable", "Внешний поиск сейчас недоступен.");
    const query = question.trim();
    if (!query || query.length > 2000 || !accountId.trim() || accountId.length > 256)
      return result("failed", "Введите вопрос до 2000 символов.");
    if (request.signal.aborted) return result("failed", "Внешний поиск отменён.");

    const startedAt = now();
    for (const [id, at] of lastAttempt) if (startedAt - at >= cooldownMs) lastAttempt.delete(id);
    if (active >= 2 || lastAttempt.has(accountId) || lastAttempt.size >= 2048)
      return result("busy", "Внешний поиск занят. Повторите запрос немного позже.");
    active++;
    lastAttempt.set(accountId, startedAt);
    const signal = AbortSignal.any([request.signal, timeoutSignal()]);
    try {
      const reservation = await budget(accountId, "web").catch(() => ({ allowed: false, reason: "unavailable" }) as const);
      signal.throwIfAborted();
      if (!reservation.allowed) return reservation.reason === "quota"
        ? result("busy", "Лимит внешнего поиска исчерпан.")
        : result("unavailable", "Внешний поиск сейчас недоступен.");

      const token = apiKey ?? await getMetadataToken().catch(() => undefined);
      signal.throwIfAborted();
      if (!token) return result("unavailable", "Внешний поиск сейчас недоступен.");
      const response = await fetcher(endpoint, {
        method: "POST", cache: "no-store", redirect: "error", signal,
        headers: { Authorization: `${apiKey ? "Api-Key" : "Bearer"} ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ folderId, messages: [{ role: "ROLE_USER", content: query }], fixMisspell: true, getPartialResults: false }),
      });
      if (response.ok) return parseAnswer(await readYandexJson(response, maxResponseBytes, signal));
      void response.body?.cancel().catch(() => {});
      if (response.status === 429) return result("busy", "Внешний поиск занят. Повторите запрос немного позже.");
      if (response.status === 401 || response.status === 403) return result("unavailable", "Внешний поиск сейчас недоступен.");
      return result("failed", "Не удалось получить ответ внешнего поиска.");
    } catch {
      return request.signal.aborted
        ? result("failed", "Внешний поиск отменён.")
        : result("failed", "Не удалось получить ответ внешнего поиска.");
    } finally {
      active--;
    }
  };
}

export const answerWebChat = createWebChat({
  env: process.env, fetcher: (...args) => fetch(...args),
  budget: consumeAiBudget, getMetadataToken: getMetadataIamToken,
});
