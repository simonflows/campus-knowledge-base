import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Page, Request } from "playwright-core";
import { BROWSER_DEMO_KEY } from "../lib/browser-demo";

export async function runFollowupBrowserChecks(page: Page, base: string) {
  const title = "QA удаление " + randomUUID();
  await page.goto(base + "/editor");
  assert.equal(await page.locator("header a[href$='/demo']").count(), 0, "The working header does not link to the retired demo");
  await page.getByLabel("Заголовок", { exact: true }).fill(title);
  await page.getByLabel("Лид", { exact: true }).fill("Синтетический черновик для проверки удаления.");
  const saving = page.waitForResponse(response =>
    response.url() === base + "/api/editor/drafts" && response.request().method() === "POST"
  );
  await page.getByRole("button", { name: "Сохранить черновик", exact: true }).click();
  const created = await saving;
  assert.equal(created.status(), 201);
  const document = await created.json();
  await page.getByRole("button", { name: "Удалить черновик", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Удалить черновик?", exact: true });
  await confirmation.getByRole("button", { name: "Отмена", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  assert.equal((await page.request.get(base + "/api/editor/drafts/" + document.id)).status(), 200);
  await page.getByRole("button", { name: "Удалить черновик", exact: true }).click();
  await confirmation.getByRole("button", { name: "Удалить", exact: true }).click();
  await confirmation.waitFor({ state: "hidden" });
  assert.equal((await page.request.get(base + "/api/editor/drafts/" + document.id)).status(), 404);
  await page.reload();
  await page.getByRole("heading", { name: "Умный редактор", exact: true }).waitFor();
  assert.equal(await page.getByText(title, { exact: true }).count(), 0);

  const cookiesBefore = await page.context().cookies(base);
  const identityBefore = await (await page.request.get(base + "/api/auth/session")).json();
  const legacyValue = "retained-" + randomUUID();
  const savedDemoData = await page.evaluate((key) => localStorage.getItem(key), BROWSER_DEMO_KEY);
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
    key: BROWSER_DEMO_KEY, value: legacyValue,
  });
  const writes: string[] = [];
  const recordWrite = (request: Request) => {
    const url = new URL(request.url());
    if (url.origin === base && url.pathname.startsWith("/api/") &&
        ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      writes.push(request.method() + " " + url.pathname);
    }
  };
  page.on("request", recordWrite);
  try {
    await page.goto(base + "/demo?old=1#/editor?draft=legacy");
    const location = new URL(page.url());
    assert.equal(location.pathname, "/login");
    assert.equal(location.search, "");
    assert.equal(location.hash, "");
    assert.equal(await page.locator("a[href$='/demo']").count(), 0);
    assert.equal(await page.getByRole("link", { name: "Выйти из демо", exact: true }).count(), 0);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), BROWSER_DEMO_KEY), legacyValue);
    assert.deepEqual(writes, [], "Opening the legacy link does not send API writes");
    assert.ok(isDeepStrictEqual(await page.context().cookies(base), cookiesBefore), "The legacy URL preserves working cookies");
  } finally {
    page.off("request", recordWrite);
    await page.evaluate(({ key, saved }) => {
      if (saved === null) localStorage.removeItem(key);
      else localStorage.setItem(key, saved);
    }, { key: BROWSER_DEMO_KEY, saved: savedDemoData });
  }
  const identityAfter = await (await page.request.get(base + "/api/auth/session")).json();
  assert.equal(identityAfter.user.id, identityBefore.user.id);
  console.log("PASS: real editor delete/cancel/reload and legacy redirect preserving the signed-in session and stored browser data");
}
