export type YandexAiMessage = {
  role: "system" | "user" | "assistant";
  text: string;
};

const ALICE_AI_FLASH_URI = /^gpt:\/\/[^/]+\/aliceai-llm-flash$/;

export class MissingYandexCredentialsError extends Error {
  constructor() {
    super(
      "Не настроены ключи Yandex AI Studio: YANDEX_AI_STUDIO_API_KEY и YANDEX_AI_STUDIO_FOLDER_ID"
    );
    this.name = "MissingYandexCredentialsError";
  }
}

export class YandexAiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "YandexAiError";
  }
}

export function isYandexAiConfigured(): boolean {
  return Boolean(
    process.env.YANDEX_AI_STUDIO_API_KEY &&
    process.env.YANDEX_AI_STUDIO_FOLDER_ID
  );
}

export function getYandexModelLabel(): string {
  const uri = process.env.YANDEX_AI_STUDIO_MODEL_URI;
  if (!uri) return "yandexgpt/latest";
  if (ALICE_AI_FLASH_URI.test(uri)) return "aliceai-llm-flash";
  const publicModel =
    /^gpt:\/\/[^/]+\/(yandexgpt(?:-lite)?\/(?:latest|rc|deprecated))$/.exec(
      uri
    );
  return publicModel?.[1] ?? "Модель Yandex AI Studio";
}

export type AiCompletion = {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
};

export function parseTokenUsage(
  input: unknown,
  output: unknown
): AiCompletion["usage"] {
  const inputTokens =
    typeof input === "string" && /^\d+$/.test(input) ? Number(input) : input;
  const outputTokens =
    typeof output === "string" && /^\d+$/.test(output)
      ? Number(output)
      : output;
  if (
    typeof inputTokens !== "number" ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  )
    return null;
  return { inputTokens, outputTokens };
}

export async function callYandexAi(
  messages: YandexAiMessage[],
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  return (await callYandexAiWithUsage(messages, options)).text;
}

function parseCompletion(
  content: unknown,
  inputTokens: unknown,
  outputTokens: unknown
): AiCompletion {
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) {
    throw new YandexAiError("Yandex AI Studio вернул пустой ответ");
  }
  return { text, usage: parseTokenUsage(inputTokens, outputTokens) };
}

export async function callYandexAiWithUsage(
  messages: YandexAiMessage[],
  options: { temperature?: number; maxTokens?: number; signal?: AbortSignal } = {}
): Promise<AiCompletion> {
  const apiKey = process.env.YANDEX_AI_STUDIO_API_KEY;
  const folderId = process.env.YANDEX_AI_STUDIO_FOLDER_ID;

  if (!apiKey || !folderId) {
    throw new MissingYandexCredentialsError();
  }

  const modelUri =
    process.env.YANDEX_AI_STUDIO_MODEL_URI ??
    `gpt://${folderId}/yandexgpt/latest`;
  const useChatCompletions = ALICE_AI_FLASH_URI.test(modelUri);
  const temperature = options.temperature ?? 0.05;
  const maxTokens = options.maxTokens ?? 4_000;
  const body = useChatCompletions
    ? {
        model: modelUri,
        messages: messages.map(({ role, text }) => ({ role, content: text })),
        stream: false,
        temperature,
        max_completion_tokens: maxTokens,
      }
    : {
        modelUri,
        completionOptions: {
          stream: false,
          temperature,
          maxTokens: String(maxTokens),
        },
        messages,
      };

  let response: Response;

  try {
    response = await fetch(
      useChatCompletions
        ? "https://ai.api.cloud.yandex.net/v1/chat/completions"
        : "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
      {
        method: "POST",
        headers: {
          Authorization: `Api-Key ${apiKey}`,
          "Content-Type": "application/json",
          ...(useChatCompletions && { "x-data-logging-enabled": "false" }),
        },
        body: JSON.stringify(body),
        signal: options.signal ?? AbortSignal.timeout(60_000),
      }
    );
  } catch {
    throw new YandexAiError("Не удалось связаться с Yandex AI Studio");
  }

  if (!response.ok) {
    throw new YandexAiError(
      `Yandex AI Studio вернул ошибку HTTP ${response.status}`,
      response.status
    );
  }

  const data: unknown = await response.json().catch(() => null);
  if (useChatCompletions) {
    const chat = data as {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: unknown };
      }>;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    } | null;
    const choice = chat?.choices?.[0];
    if (choice && choice.finish_reason !== "stop") {
      throw new YandexAiError("Yandex AI Studio вернул незавершённый ответ");
    }
    return parseCompletion(
      choice?.message?.content,
      chat?.usage?.prompt_tokens,
      chat?.usage?.completion_tokens
    );
  }

  const foundation = data as {
    result?: {
      alternatives?: Array<{ status?: string; message?: { text?: unknown } }>;
      usage?: { inputTextTokens?: unknown; completionTokens?: unknown };
    };
  } | null;

  const alternative = foundation?.result?.alternatives?.[0];
  if (
    alternative?.status &&
    alternative.status !== "ALTERNATIVE_STATUS_FINAL"
  ) {
    throw new YandexAiError("Yandex AI Studio вернул незавершённый ответ");
  }

  return parseCompletion(
    alternative?.message?.text,
    foundation?.result?.usage?.inputTextTokens,
    foundation?.result?.usage?.completionTokens
  );
}
