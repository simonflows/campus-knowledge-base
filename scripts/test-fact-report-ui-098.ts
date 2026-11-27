import assert from "node:assert/strict";
import type { Page, Route } from "playwright-core";
import { createToolResponseFixture, fulfillToolResponse } from "./test-fact-result-ui-097";

export async function runFactReportUiChecks(page: Page, base: string) {
  const fixture = createToolResponseFixture();
  let reject = false;
  const endpoint = base + "/api/fact-check";
  const respond = async (route: Route) => {
    if (reject) {
      await route.fulfill({
        status: 503,
        json: { error: "Тестовый отказ сервиса" },
      });
      return;
    }
    const response = await fixture(route);
    const isCheck = route.request().postDataJSON().mode === "check";
    // Model availability is controlled in the fixture so the working fallback can be checked offline.
    const result = isCheck && response.ok
      ? Response.json({ ...(await response.json()), ai: { status: "unavailable" } })
      : response;
    await fulfillToolResponse(route, result);
  };
  await page.route(endpoint, respond);
  try {
    await checkFactReport(page, base, () => { reject = true; });
  } finally {
    await page.unroute(endpoint, respond);
  }
}

async function checkFactReport(page: Page, base: string, rejectService: () => void) {
  await page.goto(base + "/check");
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
    /ИИ сейчас недоступен.*Показан результат проверки по правилам/
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

  const check = page.getByRole("button", {
    name: "Проверить текст",
    exact: true,
  });
  await input.fill(
    "Мне нравится Челябинск, а новые поколения тонко чувствуют ложь."
  );
  await check.click();
  await coverage.waitFor();
  rejectService();
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
