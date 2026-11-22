import { NextRequest, NextResponse } from "next/server";
import { getComparisonStorageMode } from "@/lib/deploy-storage";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import { z } from "zod";

import {
  AlibabaAiError,
  callAlibabaAi,
  getAlibabaModelName,
  isAlibabaAiConfigured,
} from "@/lib/alibaba-ai";
import {
  getSessionUser,
  isAdminPinRequired,
  verifySameOrigin,
} from "@/lib/auth-server";
import { demoLoginEnabled } from "@/lib/pilot-auth";
import {
  assessBenchmarkOutput,
  BENCHMARK_FIXTURE_VERSION,
  BENCHMARK_SCENARIO_IDS,
  getBenchmarkMessages,
  getBenchmarkScenario,
  type BenchmarkProviderResult,
  type BenchmarkResponse,
  type BenchmarkScenarioId,
} from "@/lib/benchmark";
import {
  callYandexAiWithUsage,
  getYandexModelLabel,
  isYandexAiConfigured,
  YandexAiError,
} from "@/lib/yandex-ai";

const benchmarkInputSchema = z.strictObject({
  scenario: z.enum(["all", ...BENCHMARK_SCENARIO_IDS]).default("all"),
  mode: z.enum(["reference", "live"]).default("reference"),
});

const RUN_COOLDOWN_MS = 60_000;
const HOURLY_RUN_LIMIT = 6;
const benchmarkLimit = globalThis as typeof globalThis & {
  campusBenchmarkRuns?: number[];
};

function reserveRun(now: number): number {
  const hour = 60 * 60 * 1000;
  const runs = (benchmarkLimit.campusBenchmarkRuns ?? []).filter(
    (time) => now - time < hour
  );
  const lastRun = runs.at(-1);
  const nextAllowed =
    runs.length >= HOURLY_RUN_LIMIT
      ? runs[0] + hour
      : (lastRun ?? -Infinity) + RUN_COOLDOWN_MS;
  if (nextAllowed > now) return Math.ceil((nextAllowed - now) / 1000);
  benchmarkLimit.campusBenchmarkRuns = [...runs, now];
  return 0;
}

async function runPlatform(
  platform: "yandex" | "alibaba",
  scenario: BenchmarkScenarioId,
  requested: "reference" | "live",
  configured: boolean,
  model: string
): Promise<BenchmarkProviderResult> {
  const empty = { usage: null, structure: [], output: null };
  if (requested === "reference" || !configured) {
    return {
      ...empty,
      mode: "skipped",
      model: null,
      latencyMs: null,
      message:
        requested === "reference"
          ? "Локальный эталон"
          : "Подключение провайдера не настроено",
    };
  }

  const start = performance.now();
  try {
    const options = {
      temperature: 0.05,
      maxTokens: scenario === "article" ? 2200 : 1200,
    };
    const response =
      platform === "yandex"
        ? await callYandexAiWithUsage(getBenchmarkMessages(scenario), options)
        : await callAlibabaAi(scenario, options);
    const latencyMs = Math.round(performance.now() - start);
    return {
      mode: "live",
      model,
      latencyMs,
      ...assessBenchmarkOutput(scenario, response.text),
      usage: response.usage,
      message: null,
    };
  } catch (error) {
    const status =
      error instanceof YandexAiError || error instanceof AlibabaAiError
        ? error.status
        : null;
    return {
      ...empty,
      mode: "error",
      model,
      latencyMs: Math.round(performance.now() - start),
      message: status
        ? `Сбой API (HTTP ${status})`
        : "Облачный вызов не завершён",
    };
  }
}

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request))
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );

  const parsed = benchmarkInputSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: "Некорректные параметры запуска полигона" },
      { status: 400 }
    );

  const { scenario, mode } = parsed.data;
  const yandexConfigured = isYandexAiConfigured();
  const alibabaConfigured = isAlibabaAiConfigured();
  if (mode === "live") {
    const user = await getSessionUser();
    if (!user)
      return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
    if (user.role !== "admin" || (demoLoginEnabled() && !isAdminPinRequired()))
      return NextResponse.json(
        {
          error:
            "Облачный прогон доступен администратору пилота. Для демовхода настройте PIN администратора.",
        },
        { status: 403 }
      );
  }

  if (!(await getComparisonStorageMode())) return unavailableStorageResponse();

  if (mode === "live" && (yandexConfigured || alibabaConfigured)) {
    const retryAfter = reserveRun(Date.now());
    if (retryAfter > 0)
      return NextResponse.json(
        {
          error: `Лимит облачных прогонов. Повторите через ${retryAfter} сек.`,
        },
        { status: 429, headers: { "Retry-After": String(retryAfter) } }
      );
  }

  const ids = scenario === "all" ? BENCHMARK_SCENARIO_IDS : [scenario];
  const scenarios = await Promise.all(
    ids.map(async (id) => {
      const [yandexRun, alibabaRun] = await Promise.all([
        runPlatform(
          "yandex",
          id,
          mode,
          yandexConfigured,
          getYandexModelLabel()
        ),
        runPlatform(
          "alibaba",
          id,
          mode,
          alibabaConfigured,
          getAlibabaModelName()
        ),
      ]);
      return {
        ...getBenchmarkScenario(id),
        yandex: yandexRun,
        alibaba: alibabaRun,
      };
    })
  );

  const response: BenchmarkResponse = {
    executedAt: new Date().toISOString(),
    fixtureVersion: BENCHMARK_FIXTURE_VERSION,
    mode,
    livePlatforms: { yandex: yandexConfigured, alibaba: alibabaConfigured },
    scenarios,
  };
  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store" },
  });
}
