import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { requireFixtureDatabase } from "./qa-fixture";
import { installPilotFixture } from "./pilot-fixture";
import { knowledgeSeedCards } from "../lib/knowledge";
import { runEditorialRoutes } from "./test-editorial-routes";
import { runCanonRoutes } from "./test-canon-routes";
import { measurePilotLoad } from "./measure-pilot-load";
import runRequestBrowserChecks from "./requests-browser-check";
import { runFollowupBrowserChecks } from "./followup-browser-check";
import { runFactResultUiChecks } from "./test-fact-result-ui-097";
import { runFactReportUiChecks } from "./test-fact-report-ui-098";
import { runAssistantUiChecks } from "./test-assistant-ui-098";
import { runReleaseNotesUiChecks } from "./test-release-notes-ui-098";
import { runFactStreamUiChecks } from "./test-fact-stream-ui-098";

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
    const readiness = await fetch(base + "/api/ready");
    assert.equal(readiness.status, 200, "Isolated production server must see all working tables");
    const loadProfile = process.env.CAMPUS_QA_MEASURE_LOAD;
    if (loadProfile === "smoke" || loadProfile === "pilot") {
      await measurePilotLoad(credentials("demo-pr-midis"), loadProfile);
    }
    await runEditorialRoutes(credentials);
    await runCanonRoutes(credentials);
    const browser = await chromium.launch({ channel: process.env.CAMPUS_QA_CHROME_CHANNEL || "chrome", headless: true });
    try {
      const factResultPage = await browser.newPage();
      try { await runFactResultUiChecks(factResultPage, base); await runFactReportUiChecks(factResultPage, base); }
      finally { await factResultPage.close(); }
      const releaseUiPage = await browser.newPage();
      try { await runAssistantUiChecks(releaseUiPage, base); await runReleaseNotesUiChecks(releaseUiPage, base); }
      finally { await releaseUiPage.close(); }
      const streamUiPage = await browser.newPage();
      try { await runFactStreamUiChecks(streamUiPage, base); }
      finally { await streamUiPage.close(); }
      const analyticsPage = await browser.newPage({ reducedMotion: "reduce" });
      const analyticsLogin = await analyticsPage.request.post(base + "/api/auth/session", {
        headers: { Origin: base },
        data: credentials("demo-pr-midis"),
      });
      assert.equal(analyticsLogin.status(), 200);
      await analyticsPage.goto(base + "/analytics");
      assert.equal(new URL(analyticsPage.url()).pathname, "/analytics");
      const example = analyticsPage.getByRole("complementary", { name: "Примеры запросов" }).getByRole("button").first();
      await example.waitFor();
      const query = await example.innerText();
      await example.click();
      assert.equal(await analyticsPage.getByLabel("Запрос к базе", { exact: true }).inputValue(), query.trim());
      const [analyticsResult] = await Promise.all([
        analyticsPage.waitForResponse(response =>
          response.request().method() === "POST" && new URL(response.url()).pathname === "/api/analytics"
        ),
        analyticsPage.getByRole("button", { name: "Собрать аналитику", exact: true }).click(),
      ]);
      assert.equal(analyticsResult.status(), 200);
      const report = await analyticsResult.json();
      assert.ok(report.cards?.length > 0, "A displayed example must match an available approved card");
      assert.equal(report.summary.total, report.cards.length);
      const metrics = analyticsPage.locator(".data-report-metrics");
      await metrics.waitFor();
      const visibleMetrics = await metrics.locator("dd").evaluateAll(cells => cells.map(cell => {
        const value = cell.firstElementChild!.getBoundingClientRect();
        const track = cell.querySelector("[aria-hidden='true']")!.getBoundingClientRect();
        return value.height > track.height && value.bottom <= track.top;
      }));
      assert.deepEqual(visibleMetrics, [true, true, true, true], "Analytics figures must stand above their tracks");
      for (const width of [1440, 390]) {
        await analyticsPage.setViewportSize({ width, height: 900 });
        assert.equal(await analyticsPage.evaluate(() => document.documentElement.scrollWidth), width, "Analytics report must fit at " + width);
      }
      await analyticsPage.setViewportSize({ width: 1440, height: 900 });
      await analyticsPage.getByLabel("Запрос к базе", { exact: true }).fill(
        "Собери все проекты взаимодействия вузов с индустриальными партнёрами в сфере медицины с партнёром «QA " + randomUUID() + "»"
      );
      await analyticsPage.getByRole("button", { name: "Собрать аналитику", exact: true }).click();
      const empty = analyticsPage.locator("[data-slot=empty]");
      await empty.locator("[data-slot=empty-title]").waitFor();
      for (const width of [1440, 390]) {
        await analyticsPage.setViewportSize({ width, height: 900 });
        const alignment = await empty.evaluate(element => {
          const header = element.querySelector("[data-slot=empty-header]")!.getBoundingClientRect();
          const center = (header.left + header.right) / 2;
          const rows: { top: number; left: number; right: number }[] = [];
          for (const badge of element.querySelectorAll("[data-slot=badge]")) {
            const rect = badge.getBoundingClientRect();
            const row = rows.find(row => Math.abs(row.top - rect.top) < 2);
            if (row) { row.left = Math.min(row.left, rect.left); row.right = Math.max(row.right, rect.right); }
            else rows.push({ top: rect.top, left: rect.left, right: rect.right });
          }
          const labelsOnOneLine = Array.from(element.querySelectorAll("[data-slot=badge]")).every(badge => {
            const label = badge.firstElementChild!;
            return label.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(label).lineHeight) + 1;
          });
          return { offsets: rows.map(row => (row.left + row.right) / 2 - center), labelsOnOneLine, pageWidth: document.documentElement.scrollWidth };
        });
        assert.ok(alignment.offsets.length > 0);
        assert.ok(alignment.offsets.every(offset => Math.abs(offset) <= 1), "Each filter row must align with the empty result's center at " + width);
        assert.equal(alignment.labelsOnOneLine, true, "A filter label and colon stay together at " + width);
        assert.equal(alignment.pageWidth, width);
      }
      await analyticsPage.close();
      console.log("PASS analytics numbers are separate from progress tracks");
      console.log("PASS empty analytics filters stay centered at 1440/390");

      const ownerFormPage = await browser.newPage();
      await ownerFormPage.goto(base + "/login");
      const coordinator = credentials("demo-admin");
      await ownerFormPage.getByLabel("Логин", { exact: true }).fill(coordinator.accountId);
      await ownerFormPage.getByLabel("Персональный ключ").fill(coordinator.accessKey);
      await ownerFormPage.getByRole("button", { name: "Войти", exact: true }).last().click();
      await ownerFormPage.waitForURL("**/knowledge");
      const project = knowledgeSeedCards.find(card => card.id === "project-susu-digital-twin")!;
      await ownerFormPage.goto(base + "/knowledge?card=" + project.id);
      await ownerFormPage.getByRole("button", { name: "Редактировать карточку", exact: true }).click();
      const designatedOwner = people.account("demo-owner-susu");
      await ownerFormPage.getByLabel("Персональный доступ к правке").selectOption(designatedOwner.id);
      const [update] = await Promise.all([
        ownerFormPage.waitForResponse(response =>
          response.request().method() === "PUT" &&
          new URL(response.url()).pathname === "/api/knowledge/cards/" + project.id
        ),
        ownerFormPage.getByRole("button", { name: "Сохранить изменения", exact: true }).click(),
      ]);
      assert.equal(update.status(), 200);
      const submitted = update.request().postDataJSON() as { owners: string[]; ownerIds: string[] };
      assert.deepEqual(submitted.owners, project.owners, "Each owner name must retain its organization");
      assert.deepEqual(submitted.ownerIds, [designatedOwner.id]);
      assert.deepEqual((await update.json()).ownerIds, [designatedOwner.id]);
      const longSource = await ownerFormPage.request.post(base + "/api/knowledge/cards", { data: {
        type: "laboratory", title: "QA длинный источник исторической версии", folderId: "01_universities/midis/infrastructure",
        owners: ["QA"], ownerIds: [], referenceDescription: "Официальный источник: https://example.org/" + "source".repeat(30),
        stopFormula: "Синтетический материал", affiliation: "МИДиС", partner: "QA", head: "QA",
        placementStatus: "active", placementDetails: "Учебный корпус", workDirections: [], equipment: [], confirmedIndicators: [],
      } });
      assert.equal(longSource.status(), 201);
      const longCard = await longSource.json();
      const longHistory = await (await ownerFormPage.request.get(base + "/api/knowledge/cards/" + longCard.id + "/versions")).json();
      const historicalPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await historicalPage.goto(base + "/knowledge?card=" + longCard.id + "&version=" + longHistory.currentVersionId);
        await historicalPage.getByText("Утверждённая версия", { exact: true }).waitFor();
        await historicalPage.waitForLoadState("networkidle");
        assert.equal(await historicalPage.evaluate(() => document.documentElement.scrollWidth), 390,
          "A long source in an immutable historical card must wrap within the mobile screen");
      } finally { await historicalPage.close(); }
      await ownerFormPage.close();
      console.log("PASS card edit preserves existing owner labels and assigns a personal account");
      console.log("PASS historical mobile card wraps long source URLs");

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
      await runFollowupBrowserChecks(page, base);
      await page.goto(base + "/requests#" + marker);
      const results = await runRequestBrowserChecks(page, credentials);
      assert.equal(JSON.parse(results).passed, true);
      console.log("PASS personal login form, secure browser session, requests privacy, final moderation, mobile requests page");
    } finally { await browser.close(); }
    const staff = credentials("demo-pr-midis");
    const benchmark = spawn(process.execPath, ["--import", "tsx", "scripts/test-benchmark-pilot.ts", "--http"], {
      env: { ...env, CAMPUS_BENCHMARK_HTTP_ORIGIN: base, CAMPUS_BENCHMARK_HTTP_ACCOUNT: staff.accountId, CAMPUS_BENCHMARK_HTTP_ACCESS_KEY: staff.accessKey },
      stdio: "inherit", windowsHide: true,
    });
    assert.equal((await once(benchmark, "exit"))[0], 0, "Benchmark HTTP checks failed");
  } finally { next.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
