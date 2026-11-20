export type YandexAiMessage = {
  role: "system" | "user" | "assistant";
  text: string;
};

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

export async function callYandexAiWithUsage(
  messages: YandexAiMessage[],
  options: { temperature?: number; maxTokens?: number } = {}
): Promise<AiCompletion> {
  const apiKey = process.env.YANDEX_AI_STUDIO_API_KEY;
  const folderId = process.env.YANDEX_AI_STUDIO_FOLDER_ID;

  if (!apiKey || !folderId) {
    throw new MissingYandexCredentialsError();
  }

  const modelUri =
    process.env.YANDEX_AI_STUDIO_MODEL_URI ??
    `gpt://${folderId}/yandexgpt/latest`;

  let response: Response;

  try {
    response = await fetch(
      "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
      {
        method: "POST",
        headers: {
          Authorization: `Api-Key ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          modelUri,
          completionOptions: {
            stream: false,
            temperature: options.temperature ?? 0.05,
            maxTokens: String(options.maxTokens ?? 4_000),
          },
          messages,
        }),
        signal: AbortSignal.timeout(60_000),
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

  const data = (await response.json().catch(() => null)) as {
    result?: {
      alternatives?: Array<{ message?: { text?: string } }>;
      usage?: { inputTextTokens?: unknown; completionTokens?: unknown };
    };
  } | null;

  const text = data?.result?.alternatives?.[0]?.message?.text?.trim();

  if (!text) {
    throw new YandexAiError("Yandex AI Studio вернул пустой ответ");
  }

  return {
    text,
    usage: parseTokenUsage(
      data?.result?.usage?.inputTextTokens,
      data?.result?.usage?.completionTokens
    ),
  };
}
