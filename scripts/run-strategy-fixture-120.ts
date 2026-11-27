import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type APIRequestContext } from "playwright-core";
import type { StrategyAnalyticsReport } from "../lib/strategy-analytics";
import type { StrategyOptions } from "../lib/strategy";
import type { StrategyAnalyticsQuery } from "../lib/validation/analytics";
import { installPilotFixture } from "./pilot-fixture";
import { requireFixtureDatabase, requireFixtureServer } from "./qa-fixture";

const host = "127.0.0.2";
const port = 8080;
const base = `http://${host}:${port}`;
const statePath = path.resolve(".playwright-cli", "strategy-120-state.json");

const processPaths = [
  "PATH",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "HOME",
];
function selectedEnvironment(
  names: string[]
): Record<string, string | undefined> {
  return Object.fromEntries(names.map((name) => [name, process.env[name]]));
}

async function assertPortAvailable() {
  const probe = net.createServer();
  probe.listen(port, host);
  await once(probe, "listening");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve()))
  );
}

async function verifyAnalytics({
  staff,
  guest,
  login,
  ids,
}: {
  staff: APIRequestContext;
  guest: APIRequestContext;
  login: (request: APIRequestContext, profile: string) => Promise<void>;
  ids: { documentId: string; projectId: string; indicatorId: string };
}) {
  const options = await staff.get(`${base}/api/strategy/options`);
  assert.equal(options.status(), 200);
  const { documents } = (await options.json()) as StrategyOptions;
  const document = documents.find(({ cardId }) => cardId === ids.documentId);
  assert.ok(document);
  const direction = document.document.directions[0];
  assert.ok(direction);
  const query: StrategyAnalyticsQuery = {
    mode: "strategy",
    documentId: document.cardId,
    documentVersionId: document.versionId,
    target: { kind: "direction", id: direction.id },
  };
  const post = (context: APIRequestContext, data: unknown = query) =>
    context.post(`${base}/api/analytics`, { headers: { Origin: base }, data });
  const response = await post(staff);
  assert.equal(response.status(), 200);
  assert.match(response.headers()["cache-control"] ?? "", /private.*no-store/);
  const report = (await response.json()) as StrategyAnalyticsReport;
  assert.deepEqual(report.document, {
    cardId: document.cardId,
    versionId: document.versionId,
    title: document.title,
  });
  assert.deepEqual(report.target, {
    kind: "direction",
    label: direction.title,
  });
  assert.ok(
    report.projects.some(
      ({ card, status }) =>
        card.cardId === ids.projectId && status === "current"
    )
  );
  const indicator = report.indicators.find(
    ({ card }) => card.cardId === ids.indicatorId
  );
  assert.ok(indicator);
  assert.equal(indicator.unit, "шт.");
  assert.deepEqual(indicator.scope, { kind: "campus" });
  assert.deepEqual(indicator.plan, {
    status: "confirmed",
    value: 6,
    date: "2027-08-01",
    source: { card: report.document, clauseLocator: "Пункт QA 1" },
  });
  assert.deepEqual(indicator.actual, {
    status: "confirmed",
    value: 0,
    date: "2026-11-25",
    source: { card: report.document, clauseLocator: "Пункт QA 2" },
  });

  assert.equal(
    (await post(staff, { ...query, documentVersionId: "invalid" })).status(),
    400
  );
  assert.equal(
    (
      await post(staff, { ...query, documentVersionId: `cv-${"0".repeat(64)}` })
    ).status(),
    404
  );
  assert.equal(
    (
      await post(staff, {
        ...query,
        target: { kind: "clause", id: "missing-qa-clause" },
      })
    ).status(),
    404
  );
  assert.equal((await post(guest)).status(), 401);
  await login(guest, "demo-guest");
  assert.equal((await post(guest)).status(), 403);
  console.log(
    "PASS strategy analytics HTTP: confirmed plan and zero actual, source versions, invalid filters, unsigned and guest access"
  );
}

async function run() {
  await requireFixtureDatabase();
  await assertPortAvailable();
  process.env.CAMPUS_QA_ORIGIN = base;
  const people = installPilotFixture();
  const env: NodeJS.ProcessEnv = {
    ...selectedEnvironment([
      ...processPaths,
      "DOCUMENT_API_ENDPOINT",
      "DOCUMENT_API_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "CAMPUS_PILOT_ACCOUNTS",
    ]),
    NODE_ENV: "production",
    USE_DATABASE: "true",
    CAMPUS_DEMO_LOGIN: "false",
    CAMPUS_LOCAL_DEMO: "false",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    YANDEX_DISK_OAUTH_TOKEN: "",
    YANDEX_AI_STUDIO_API_KEY: "",
    ALIBABA_DASHSCOPE_API_KEY: "",
    NEXT_TELEMETRY_DISABLED: "1",
    CAMPUS_PUBLIC_ORIGIN: base,
  };
  const server = spawn(
    process.execPath,
    [
      path.join("node_modules", "next", "dist", "bin", "next"),
      "start",
      "-H",
      host,
      "-p",
      String(port),
    ],
    {
      env,
      stdio: "inherit",
      windowsHide: true,
    }
  );
  const serverClosed = once(server, "close");

  async function login(request: APIRequestContext, profile: string) {
    const row = people.rows.find((item) => item.profile === profile);
    assert.ok(row, "QA account profile missing");
    const response = await request.post(`${base}/api/auth/session`, {
      headers: { Origin: base },
      data: { accountId: row.login, accessKey: people.keys.get(profile) },
    });
    assert.ok(response.ok(), `QA account login returned ${response.status()}`);
  }

  try {
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      assert.equal(
        server.exitCode,
        null,
        "Isolated QA server exited before readiness"
      );
      ready = await fetch(`${base}/api/health`)
        .then((response) => response.ok)
        .catch(() => false);
      if (ready) break;
      await delay(300);
    }
    assert.ok(ready, "Isolated QA server is unavailable");
    assert.equal((await fetch(`${base}/api/ready`)).status, 200);
    assert.equal(await requireFixtureServer(), base);

    const browser = await chromium.launch({
      channel: process.env.CAMPUS_QA_CHROME_CHANNEL || "chrome",
    });
    let stateCreated = false;
    try {
      const coordinator = await browser.newPage({ reducedMotion: "reduce" });
      const guest = await browser.newPage();
      const errors: string[] = [];
      coordinator.on("pageerror", (error) => errors.push(error.message));
      await login(coordinator.request, "demo-admin");
      const { runStrategyUi } = await import("./test-strategy-ui-120");
      const ids = await runStrategyUi(coordinator, base).catch(
        async (error) => {
          await coordinator.screenshot({
            path: ".playwright-cli/strategy-120-failure.png",
            fullPage: true,
          });
          await writeFile(
            ".playwright-cli/strategy-120-failure.txt",
            await coordinator.locator("body").innerText()
          );
          throw error;
        }
      );
      assert.deepEqual(errors, []);
      console.log(
        "PASS strategy knowledge UI: documents, links, separate confirmations, zero and stale source, keyboard, 320/390/768/1440"
      );
      await verifyAnalytics({
        staff: coordinator.request,
        guest: guest.request,
        login,
        ids,
      });

      await mkdir(path.dirname(statePath), { recursive: true });
      await writeFile(
        statePath,
        JSON.stringify(await coordinator.context().storageState()),
        { flag: "wx", mode: 0o600 }
      );
      stateCreated = true;
      const analyticsUi = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--test",
          "scripts/test-strategy-analytics-ui-120.ts",
        ],
        {
          env: {
            ...selectedEnvironment(processPaths),
            NODE_ENV: "test",
            CAMPUS_QA_CHROME_CHANNEL:
              process.env.CAMPUS_QA_CHROME_CHANNEL || "chrome",
            CAMPUS_UI_ORIGIN: base,
            CAMPUS_UI_STORAGE_STATE: statePath,
          },
          stdio: "inherit",
          windowsHide: true,
        }
      );
      assert.equal(
        (await once(analyticsUi, "exit"))[0],
        0,
        "Strategy analytics UI checks failed"
      );
      const author = await browser.newPage();
      await login(author.request, "demo-pr-midis");
      const { runStrategyEditorChecks } =
        await import("./test-strategy-editor-120");
      await runStrategyEditorChecks(
        author.request,
        coordinator.request,
        base,
        ids
      );
    } finally {
      try {
        if (stateCreated) await unlink(statePath);
      } finally {
        await browser.close();
      }
    }
  } finally {
    if (server.exitCode === null) server.kill();
    await serverClosed;
  }
}

void run().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Strategy fixture failed"
  );
  process.exitCode = 1;
});
