import { demoAccounts } from "./auth";
import type { KnowledgeCard } from "./knowledge";
import { getBenchmarkMessages, type BenchmarkScenarioId } from "./benchmark";
import { parseTokenUsage, type AiCompletion } from "./yandex-ai";

export const DEFAULT_ALIBABA_BASE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_ALIBABA_MODEL = "qwen-plus";

const DASHSCOPE_HOSTS = new Set([
  "dashscope.aliyuncs.com",
  "dashscope-intl.aliyuncs.com",
  "cn-hongkong.dashscope.aliyuncs.com",
]);
const REGIONAL_ENDPOINT =
  /^[a-z0-9-]+\.(?:ap-southeast-1|cn-beijing|cn-hongkong|eu-central-1|ap-northeast-1|us-east-1)\.maas\.aliyuncs\.com$/;

export function validateExternalHttpsUrl(rawUrl: string): {
  valid: boolean;
  reason?: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { valid: false, reason: "Некорректный формат URL" };
  }

  if (parsed.protocol !== "https:") {
    return {
      valid: false,
      reason: "Endpoint Alibaba Cloud должен использовать протокол https://",
    };
  }

  const host = parsed.hostname.toLowerCase();
  if (
    (!DASHSCOPE_HOSTS.has(host) && !REGIONAL_ENDPOINT.test(host)) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname.replace(/\/$/, "") !== "/compatible-mode/v1"
  ) {
    return {
      valid: false,
      reason: "Укажите официальный endpoint Alibaba Cloud Model Studio",
    };
  }

  return { valid: true };
}

export class MissingAlibabaCredentialsError extends Error {
  constructor() {
    super(
      "Не настроен ключ Alibaba Cloud Model Studio: ALIBABA_DASHSCOPE_API_KEY"
    );
    this.name = "MissingAlibabaCredentialsError";
  }
}

export class AlibabaAiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "AlibabaAiError";
  }
}

export function isAlibabaAiConfigured(): boolean {
  return Boolean(process.env.ALIBABA_DASHSCOPE_API_KEY);
}

export function getAlibabaModelName(): string {
  return process.env.ALIBABA_MODEL_NAME || DEFAULT_ALIBABA_MODEL;
}

const KNOWN_PERSONAL_NAMES = Array.from(
  new Set(
    demoAccounts
      .flatMap((account) => [account.name, ...account.ownerAliases])
      .filter(
        (name) => name.trim().includes(" ") && name !== "Администратор канона"
      )
  )
);

/**
 * Упрощённая маскировка известных форматов контактов для старых вызовов.
 * Облачный полигон пользуется отдельным фиксированным набором.
 */
export function sanitizeTextFor152FZ(text: string): string {
  let sanitized = text
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[email скрыт]")
    .replace(
      /(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}/g,
      "[телефон скрыт]"
    )
    .replace(
      /((?:Владельцы|Руководитель)\s*:\s*)([^\n]+)/gi,
      "$1[контакт скрыт]"
    );

  for (const fullName of KNOWN_PERSONAL_NAMES) {
    const escaped = fullName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    sanitized = sanitized.replace(new RegExp(escaped, "gi"), "[имя скрыто]");
  }

  return sanitized;
}

export function sanitizeCardFor152FZ(card: KnowledgeCard): KnowledgeCard {
  const anonymizedOwners = card.owners.map((owner, index) => {
    const parts = owner.split(",");
    const org = parts.slice(1).join(",").trim();
    return org
      ? `Ответственный представитель #${index + 1} (${org}) [контакт скрыт]`
      : `Ответственный представитель #${index + 1} [контакт скрыт]`;
  });

  const baseSanitized = {
    ...card,
    owners: anonymizedOwners,
    submittedBy: undefined,
    submittedByName: undefined,
    reviewedBy: undefined,
    referenceDescription: sanitizeTextFor152FZ(card.referenceDescription),
    stopFormula: sanitizeTextFor152FZ(card.stopFormula),
  };

  if (baseSanitized.type === "laboratory") {
    return {
      ...baseSanitized,
      head: `Руководитель лаборатории (${baseSanitized.affiliation}) [контакт скрыт]`,
    };
  }

  return baseSanitized;
}

export async function callAlibabaAi(
  scenario: BenchmarkScenarioId,
  options: { temperature?: number; maxTokens?: number } = {}
): Promise<AiCompletion> {
  const apiKey = process.env.ALIBABA_DASHSCOPE_API_KEY;

  if (!apiKey) {
    throw new MissingAlibabaCredentialsError();
  }

  const baseUrl = (
    process.env.ALIBABA_DASHSCOPE_BASE_URL || DEFAULT_ALIBABA_BASE_URL
  )
    .trim()
    .replace(/\/$/, "");
  const urlCheck = validateExternalHttpsUrl(baseUrl);
  if (!urlCheck.valid) {
    throw new AlibabaAiError(
      urlCheck.reason || "Недопустимый URL Alibaba Cloud"
    );
  }

  const model = getAlibabaModelName();

  let response: Response;

  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: options.temperature ?? 0.05,
        max_tokens: options.maxTokens ?? 4_000,
        ...(/^qwen(?:-plus|-plus-latest|-plus-\d{4}-\d{2}-\d{2})$/.test(model)
          ? { enable_thinking: false }
          : {}),
        messages: getBenchmarkMessages(scenario).map((message) => ({
          role: message.role,
          content: message.text,
        })),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new AlibabaAiError(
      "Не удалось связаться с Alibaba Cloud Model Studio"
    );
  }
  if (!response.ok) {
    throw new AlibabaAiError(
      `Alibaba Cloud Model Studio вернул ошибку ${response.status}`,
      response.status
    );
  }

  const data = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  } | null;

  const text = data?.choices?.[0]?.message?.content?.trim();

  if (!text) {
    throw new AlibabaAiError("Alibaba Cloud Model Studio вернул пустой ответ");
  }

  return {
    text,
    usage: parseTokenUsage(
      data?.usage?.prompt_tokens,
      data?.usage?.completion_tokens
    ),
  };
}
