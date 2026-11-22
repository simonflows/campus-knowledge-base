import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";

async function assertReadableDemoExit(page: Page) {
  const exit = page.getByRole("link", { name: "Выйти из демо", exact: true });
  const contrast = async () => {
    const [foreground, background] = await exit.evaluate(element => {
      const style = getComputedStyle(element);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      return [style.color, style.backgroundColor].map(color => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      });
    });
    assert.equal(background[3], 255, "Demo exit needs an opaque, readable background");
    const luminance = (color: number[]) => color.slice(0, 3).map(channel => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
    const a = luminance(foreground), b = luminance(background);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  assert.ok(await contrast() >= 4.5, "Demo exit text is readable normally");
  await exit.hover();
  assert.ok(await contrast() >= 4.5, "Demo exit text is readable on hover");
  await page.mouse.move(0, 0);
  await exit.focus();
  assert.ok(await contrast() >= 4.5, "Demo exit text is readable with keyboard focus");
}

export async function runFollowupBrowserChecks(page: Page, base: string) {
  const title = "QA удаление " + randomUUID();
  await page.goto(base + "/editor");
  assert.equal(await page.locator("header a[href$='/demo']").count(), 0, "Demo entry belongs only on the login page");
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
  const attempts: string[] = [];
  const onRequest = (request: import("playwright-core").Request) => {
    // The previous working document may finish its route prefetch during handoff.
    // Observe bootstrap and all subsequent fetches belonging to the demo document.
    if (new URL(request.frame().url()).pathname !== "/demo") return;
    if (new URL(request.url()).pathname.startsWith("/api/") || ["fetch", "xhr"].includes(request.resourceType()))
      attempts.push(request.method() + " " + new URL(request.url()).pathname);
  };
  page.on("request", onRequest);
  try {
    await page.goto(base + "/demo#/knowledge");
    await page.getByRole("heading", { name: "База знаний", exact: true }).waitFor();
    await assertReadableDemoExit(page);
    await page.getByRole("navigation").first().getByRole("link", { name: "Редактор", exact: true }).click();
    await page.getByRole("heading", { name: "Умный редактор", exact: true }).waitFor();
    await page.getByLabel("Заголовок", { exact: true }).fill("Локальный " + title);
    await page.getByLabel("Лид", { exact: true }).fill("Демо: содержимое остаётся в браузере.");
    await page.getByRole("button", { name: "Сохранить черновик", exact: true }).click();
    await page.getByRole("button", { name: "Удалить черновик", exact: true }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "Умный редактор", exact: true }).waitFor();
    await page.getByRole("button", { name: new RegExp("Локальный " + title) }).first().waitFor();
    assert.deepEqual(attempts, [], "Demo editor may not issue working API or network fetches");
    assert.deepEqual(await page.context().cookies(base), cookiesBefore, "Demo preserves working cookies");
  } finally { page.off("request", onRequest); }
  await page.getByRole("link", { name: "Выйти из демо", exact: true }).click();
  const identityAfter = await (await page.request.get(base + "/api/auth/session")).json();
  assert.equal(identityAfter.user.id, identityBefore.user.id);
  console.log("PASS: real editor delete/cancel/reload and ordinary browser demo isolated from the signed-in session");
}
