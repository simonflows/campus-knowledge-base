import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { requireFixtureDatabase } from "./qa-fixture";
import { installPilotFixture } from "./pilot-fixture";
import { runEditorialRoutes } from "./test-editorial-routes";
import runRequestBrowserChecks from "./requests-browser-check";

async function main() {
  const marker = await requireFixtureDatabase();
  const host = "127.0.0.2", port = 8080, base = "http://" + host + ":" + port;
  const probe = net.createServer();
  probe.listen(port, host);
  await once(probe, "listening");
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const people = installPilotFixture();
  const credentials = (profile: string) => {
    const row = people.rows.find(row => row.profile === profile)!;
    return { accountId: row.login, accessKey: people.keys.get(profile)! };
  };
  process.env.CAMPUS_QA_ORIGIN = base;
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const name of ["PATH", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "HOME", "DOCUMENT_API_ENDPOINT", "DOCUMENT_API_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "SESSION_SECRET", "CAMPUS_PILOT_ACCOUNTS"]) {
    env[name] = process.env[name];
  }
  Object.assign(env, {
    NODE_ENV: "production", USE_DATABASE: "true", CAMPUS_DEMO_LOGIN: "false", CAMPUS_LOCAL_DEMO: "false",
    YANDEX_DISK_OAUTH_TOKEN: "", YANDEX_AI_STUDIO_API_KEY: "", ALIBABA_DASHSCOPE_API_KEY: "",
    NEXT_TELEMETRY_DISABLED: "1", CAMPUS_PUBLIC_ORIGIN: base,
  });
  const next = spawn(process.execPath, [path.join("node_modules", "next", "dist", "bin", "next"), "start", "-H", host, "-p", String(port)], { env, stdio: "inherit", windowsHide: true });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      assert.equal(next.exitCode, null, "QA server stopped early; build the project first");
      if (await fetch(base + "/api/health").then(r => r.ok).catch(() => false)) { ready = true; break; }
      await delay(300);
    }
    assert.ok(ready, "Isolated production server not ready");
    await runEditorialRoutes(credentials);
    const staff = credentials("demo-pr-midis");
    const benchmark = spawn(process.execPath, ["--import", "tsx", "scripts/test-benchmark-pilot.ts", "--http"], {
      env: { ...env, CAMPUS_BENCHMARK_HTTP_ORIGIN: base, CAMPUS_BENCHMARK_HTTP_ACCOUNT: staff.accountId, CAMPUS_BENCHMARK_HTTP_ACCESS_KEY: staff.accessKey },
      stdio: "inherit", windowsHide: true,
    });
    assert.equal((await once(benchmark, "exit"))[0], 0, "Benchmark HTTP checks failed");
    const browser = await chromium.launch({ channel: process.env.CAMPUS_QA_CHROME_CHANNEL || "chrome", headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(base + "/login#" + marker);
      await page.getByRole("heading", { name: "Вход в справочник кампуса" }).waitFor();
      const person = credentials("demo-pr-midis");
      await page.getByLabel("Логин", { exact: true }).fill(person.accountId);
      await page.getByLabel("Персональный ключ").fill(person.accessKey);
      await page.getByRole("button", { name: "Войти", exact: true }).last().click();
      await page.waitForURL("**/knowledge");
      const auth = await page.request.get(base + "/api/auth/session");
      assert.equal((await auth.json()).user.id, "pilot-" + person.accountId);
      await page.goto(base + "/requests#" + marker);
      const results = await runRequestBrowserChecks(page, credentials);
      assert.equal(JSON.parse(results).passed, true);
      console.log("PASS personal login form, secure browser session, requests privacy, final moderation, mobile requests page");
    } finally { await browser.close(); }
  } finally { next.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
