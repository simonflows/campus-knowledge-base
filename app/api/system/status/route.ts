import fs from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import {
  getAlibabaAiConfig,
  validateExternalHttpsUrl,
} from "@/lib/alibaba-ai";
import { getSessionUser } from "@/lib/auth-server";
import { getStorageMode, isStorageWritable } from "@/lib/db";
import { getYandexAiConfig } from "@/lib/yandex-ai";
import { isYandexDiskConfigured } from "@/lib/yandex-disk";

const ENV_LOCAL_PATH = path.join(process.cwd(), ".env.local");

const ALLOWED_KEYS = [
  "YANDEX_AI_STUDIO_API_KEY",
  "YANDEX_AI_STUDIO_FOLDER_ID",
  "YANDEX_AI_STUDIO_MODEL_URI",
  "YANDEX_DISK_OAUTH_TOKEN",
  "ALIBABA_DASHSCOPE_API_KEY",
  "ALIBABA_DASHSCOPE_BASE_URL",
  "ALIBABA_MODEL_NAME",
] as const;

const updateKeysSchema = z.object({
  YANDEX_AI_STUDIO_API_KEY: z.string().trim().max(500).optional(),
  YANDEX_AI_STUDIO_FOLDER_ID: z.string().trim().max(200).optional(),
  YANDEX_AI_STUDIO_MODEL_URI: z.string().trim().max(300).optional(),
  YANDEX_DISK_OAUTH_TOKEN: z.string().trim().max(500).optional(),
  ALIBABA_DASHSCOPE_API_KEY: z.string().trim().max(500).optional(),
  ALIBABA_DASHSCOPE_BASE_URL: z.string().trim().max(300).optional(),
  ALIBABA_MODEL_NAME: z.string().trim().max(120).optional(),
  clearKeys: z.array(z.enum(ALLOWED_KEYS)).optional(),
});

function buildStatusPayload(storageMode: string) {
  return {
    storageMode,
    yandexAi: getYandexAiConfig(),
    alibabaAi: getAlibabaAiConfig(),
    yandexDisk: {
      configured: isYandexDiskConfigured(),
    },
    fz152Compliant: true,
    timestamp: new Date().toISOString(),
  };
}

function parseEnvFile(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

function formatEnvValue(value: string): string {
  if (/[\s#"']/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

export async function GET() {
  const storageMode = await getStorageMode();
  return NextResponse.json(buildStatusPayload(storageMode));
}

export async function POST(request: NextRequest) {
  if (!(await isStorageWritable())) {
    return NextResponse.json(
      { error: "Сохранение ключей недоступно в статическом экспорте" },
      { status: 503 }
    );
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json(
      {
        error:
          "Войдите как Администратор канона на странице «Доступ», чтобы настраивать ключи API.",
      },
      { status: 401 }
    );
  }

  if (user.role !== "admin") {
    return NextResponse.json(
      {
        error:
          "Изменять ключи API может только Администратор канона (/login).",
      },
      { status: 403 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Некорректный JSON в теле запроса" },
      { status: 400 }
    );
  }

  const parsed = updateKeysSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "Проверьте корректность введённых параметров",
        details: parsed.error.flatten(),
      },
      { status: 400 }
    );
  }

  const incomingBaseUrl = parsed.data.ALIBABA_DASHSCOPE_BASE_URL;
  if (incomingBaseUrl) {
    const urlCheck = validateExternalHttpsUrl(incomingBaseUrl);
    if (!urlCheck.valid) {
      return NextResponse.json(
        {
          error:
            urlCheck.reason ||
            "ALIBABA_DASHSCOPE_BASE_URL должен быть внешним https-адресом",
        },
        { status: 400 }
      );
    }
  }

  let existingContent = "";
  try {
    existingContent = await fs.readFile(ENV_LOCAL_PATH, "utf8");
  } catch {
    existingContent = "";
  }

  const envMap = parseEnvFile(existingContent);

  if (parsed.data.clearKeys) {
    for (const keyToClear of parsed.data.clearKeys) {
      envMap.delete(keyToClear);
      delete process.env[keyToClear];
    }
  }

  for (const key of ALLOWED_KEYS) {
    const incoming = parsed.data[key];
    if (incoming !== undefined && incoming !== "") {
      envMap.set(key, incoming);
      process.env[key] = incoming;
    }
  }

  const lines = [
    "# Локальная конфигурация ключей кампуса «Южный Урал»",
    "# Автоматически сгенерировано мастером настройки",
    "",
  ];
  for (const [key, value] of envMap.entries()) {
    lines.push(`${key}=${formatEnvValue(value)}`);
  }

  await fs.writeFile(ENV_LOCAL_PATH, `${lines.join("\n")}\n`, "utf8");

  const storageMode = await getStorageMode();
  return NextResponse.json({
    saved: true,
    ...buildStatusPayload(storageMode),
  });
}
