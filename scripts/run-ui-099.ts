import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium, type Route } from "playwright-core";
import { getDemoCard } from "../lib/browser-demo";
import candidateData from "../data/pilot-0.9.5-candidates.json";
import { createToolResponseFixture, fulfillToolResponse } from "./test-fact-result-ui-097";

async function main() {
  const base = "http://localhost:8080";
  const fixture = createToolResponseFixture(state => {
    const passport = getDemoCard(state, "campus-passport");
    const candidate = candidateData.cards.find(({ card }) => card.id === "campus-passport")?.card;
    assert.ok(passport?.type === "campus" && candidate?.campusMetrics);
    state.updates = [{ ...passport, referenceDescription: candidate.referenceDescription,
      campusMetrics: candidate.campusMetrics, verifiedFacts: [] }];
  });
  const browser = await chromium.launch({ channel: process.env.CAMPUS_QA_CHROME_CHANNEL ?? "chrome" });
  try {
    const page = await browser.newPage();
    const apiRequests: string[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    const respond = async (route: Route) => {
      apiRequests.push(route.request().method() + " " + new URL(route.request().url()).pathname);
      await fulfillToolResponse(route, await fixture(route));
    };
    await page.route(base + "/api/assistant", respond);
    await page.route(base + "/api/fact-check", respond);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(base + "/");
    await page.getByRole("button", { name: "Открыть помощник Канона", exact: true }).click();
    const question = page.getByPlaceholder("Введите вопрос", { exact: true });
    await question.fill("Какова площадь кампуса?");
    await page.getByRole("button", { name: "Отправить вопрос", exact: true }).click();
    const conversation = page.getByLabel("Переписка с помощником", { exact: true });
    await conversation.getByText(/Общая площадь кампуса не указана/).waitFor();
    assert.match(await conversation.getByRole("link", { name: /Паспорт кампуса/ }).getAttribute("href") ?? "", /version=/u);
    await question.fill("Сколько мест для проживания в кампусе?");
    await page.getByRole("button", { name: "Отправить вопрос", exact: true }).click();
    await conversation.getByText(/Вместимость гостиниц кампуса — 3 400 мест в 8 гостиницах/).waitFor();
    const disclosure = conversation.getByText("Цитаты из карточек", { exact: true });
    await disclosure.focus();
    await page.keyboard.press("Enter");
    assert.equal(await disclosure.evaluate(element => element.closest("details")?.open), true);
    assert.equal(await page.getByRole("button", { name: "Открыть помощник Канона", exact: true }).count(), 0);
    await page.keyboard.press("Escape");

    await page.goto(base + "/check");
    const wrong = "Общая вместимость гостиниц кампуса составляет 9 999 мест.";
    const correct = wrong.replace("9 999", "3 400");
    const area = "Общая площадь кампуса составляет 114 тыс. кв. метров.";
    const second = "Вторая очередь гостиниц кампуса рассчитана на 3 064 места.";
    await page.locator("#fact-check-draft").fill([wrong, area, second].join("\n\n"));
    await page.getByRole("button", { name: "Переписать по официальным данным", exact: true }).click();
    const summary = page.getByLabel("Проверка новой редакции");
    await summary.getByText("Красных: 0", { exact: true }).waitFor();
    await summary.getByText("Жёлтых: 1", { exact: true }).waitFor();
    await summary.getByText("Зелёных: 2", { exact: true }).waitFor();
    const rewritten = page.locator("article").filter({ has: page.getByText(/Результаты проверки новой редакции/) });
    assert.ok((await rewritten.innerText()).includes(correct));
    const retainedText = rewritten.locator(".whitespace-pre-wrap");
    assert.equal(await retainedText.innerText(), [correct, area, second].join("\n\n"));
    assert.ok(await rewritten.getByText("Зелёный", { exact: true }).count() >= 2);
    assert.ok(await rewritten.getByText("Жёлтый", { exact: true }).count() >= 1);
    const original = page.locator("details").filter({ has: page.getByRole("heading", { name: "Разбор исходного текста по уровням", exact: true }) });
    assert.equal(await original.evaluate(element => (element as HTMLDetailsElement).open), false);
    await mkdir(".playwright-cli/ui-099", { recursive: true });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.getByRole("heading", { name: "Текст, переписанный по официальным данным", exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `.playwright-cli/ui-099/rewrite-${width}.png` });
    }
    assert.deepEqual(apiRequests, ["POST /api/assistant", "POST /api/assistant", "POST /api/fact-check"]);
    assert.deepEqual(pageErrors, []);
    console.log("PASS 099: direct assistant answers/versioned sources/keyboard disclosure; rewrite R1Y1G1→R0Y1G2; original separate; 390/1440px; replayed tool responses");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
