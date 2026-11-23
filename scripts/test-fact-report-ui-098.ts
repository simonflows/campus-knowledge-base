import assert from "node:assert/strict";
import type { Page } from "playwright-core";

export async function runFactReportUiChecks(page: Page, base: string) {
  await page.goto(base + "/demo#/check");
  const input = page.getByRole("textbox", { name: "Черновик текста" });
  await input.fill(
    "Мне нравится Челябинск. Новые поколения тонко чувствуют ложь. Каким будет образование завтра?"
  );
  await page
    .getByRole("button", { name: "Проверить текст", exact: true })
    .click();
  const coverage = page.getByRole("region", {
    name: "Охват проверки",
    exact: true,
  });
  await coverage.waitFor();
  assert.match(await coverage.innerText(), /Ограниченная проверка/);
  assert.match(await coverage.innerText(), /не подтверждает весь текст/);
  assert.match(
    await page.getByRole("region", { name: "Сверка с ИИ" }).innerText(),
    /нейросеть не вызывалась/
  );
  const quotedFact = "«Общая площадь кампуса составляет 114 тыс. кв. метров.»";
  await input.fill(
    "Беседа о кампусе\n\n— Что вам нравится?\n— " +
      quotedFact +
      "\n\nМне нравится характер города."
  );
  await page
    .getByRole("button", {
      name: "Переписать по официальным данным",
      exact: true,
    })
    .click();
  await page
    .getByText("Текст требует ручной сверки", { exact: true })
    .waitFor();
  assert.ok(
    (await page.locator("article").innerText()).includes(quotedFact),
    "direct speech must retain its original factual wording"
  );
  assert.ok(
    await page
      .getByText("Остались в тексте для ручной сверки", { exact: false })
      .isVisible()
  );

  await page.goto(base + "/check");
  let reject = false;
  await page.route("**/api/fact-check", async (route) => {
    if (reject) {
      await route.fulfill({
        status: 503,
        json: { error: "Тестовый отказ сервиса" },
      });
    } else {
      await route.fulfill({
        status: 200,
        json: {
          findings: [],
          checkpoints: [],
          checkedChars: 100,
          coverage: "unverified",
          canPublish: true,
          summary: { red: 0, yellow: 0, green: 0, total: 0 },
        },
      });
    }
  });
  const draft = page.getByRole("textbox", { name: "Черновик текста" });
  const check = page.getByRole("button", {
    name: "Проверить текст",
    exact: true,
  });
  await draft.fill(
    "Мне нравится Челябинск, а новые поколения тонко чувствуют ложь."
  );
  await check.click();
  await coverage.waitFor();
  reject = true;
  await check.click();
  await page
    .getByText("Тестовый отказ сервиса", { exact: true })
    .first()
    .waitFor();
  assert.equal(
    await coverage.count(),
    0,
    "an error must not leave an old report on screen"
  );
}
