import assert from "node:assert/strict";
import type { Page } from "playwright-core";

export async function runAssistantUiChecks(page: Page, base: string) {
  await page.route("**/api/**", (route) => route.abort());
  const apiRequests: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      apiRequests.push(new URL(request.url()).pathname);
  });
  await page.setViewportSize({ width: 320, height: 680 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(base + "/demo");
  const launcher = page.getByRole("button", {
    name: "Открыть помощник Канона",
  });
  await launcher.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Помощник Канона" });
  await dialog.waitFor();
  const examples = dialog
    .getByRole("region", { name: "Примеры вопросов" })
    .getByRole("button");
  const composer = dialog.getByRole("textbox", {
    name: "Вопрос помощнику Канона",
  });
  const send = dialog.getByRole("button", { name: "Отправить вопрос" });
  const firstSet = await examples.allTextContents();
  assert.equal(
    new Set(firstSet).size,
    3,
    "The assistant opens with three distinct examples"
  );
  assert.ok(await send.isDisabled());
  await examples.first().click();
  assert.equal(await composer.inputValue(), firstSet[0].trim());
  assert.equal(
    await composer.evaluate((node) => node === document.activeElement),
    true
  );
  assert.equal(await dialog.locator("article").count(), 0);
  const box = await dialog.boundingBox();
  assert.ok(
    box &&
      box.x > 0 &&
      box.x + box.width < 320 &&
      box.y >= 0 &&
      box.y + box.height <= 680
  );

  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await launcher.evaluate((node) => node === document.activeElement),
    true
  );
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  const secondSet = await examples.allTextContents();
  assert.equal(new Set(secondSet).size, 3);
  assert.ok(secondSet.every((question) => !firstSet.includes(question)));
  assert.equal(
    await composer.inputValue(),
    firstSet[0].trim(),
    "Draft survives reopening"
  );
  await composer.fill("Мой вопрос ещё не готов");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.keyboard.press("Enter");
  await dialog.waitFor();
  await examples.first().click();
  assert.equal(await composer.inputValue(), "Мой вопрос ещё не готов");
  await dialog.getByText(/Отправьте свой вопрос или очистите поле/).waitFor();
  assert.equal(
    await composer.evaluate((node) => node === document.activeElement),
    true
  );
  await composer.fill("");
  await examples.first().click();
  await composer.press("Shift+Enter");
  assert.equal(await dialog.locator("article").count(), 0);
  await composer.press("Enter");
  await dialog
    .locator("article")
    .getByText(/Поиск по карточкам|Поиск без нейросети/)
    .waitFor();
  assert.equal(await dialog.locator("article").count(), 1);
  assert.match(
    await dialog.locator("article").innerText(),
    /Поиск по карточкам|Поиск без нейросети/
  );
  assert.equal(await composer.inputValue(), "");
  assert.deepEqual(
    apiRequests,
    [],
    "The isolated browser demo cannot contact the working API"
  );
}
