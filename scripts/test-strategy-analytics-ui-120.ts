import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

import type { StrategyOptions } from "../lib/strategy";
import type { StrategyAnalyticsReport } from "../lib/strategy-analytics";

const origin = process.env.CAMPUS_UI_ORIGIN ?? "http://localhost:8080";
const storageState = process.env.CAMPUS_UI_STORAGE_STATE;
const document = {
  cardId: "qa-strategy-document",
  versionId: `cv-${"a".repeat(64)}`,
  title: "Учебная дорожная карта",
};
const indicator = {
  cardId: "qa-strategy-indicator",
  versionId: `cv-${"b".repeat(64)}`,
  title: "Работающие площадки",
};
const options: StrategyOptions = {
  documents: [
    {
      ...document,
      document: {
        kind: "roadmap",
        edition: "Редакция 1",
        sourceOrganization: "Фикстура",
        date: "2026-09-01",
        url: "https://example.test/qa",
        directions: [{ id: "facilities", title: "Площадки" }],
        clauses: [
          {
            id: "observed",
            locator: "1.2",
            excerpt: "Учебная выдержка",
            directionIds: ["facilities"],
            kind: "actual",
          },
        ],
      },
    },
  ],
  relatedCards: [],
};
const report: StrategyAnalyticsReport = {
  document,
  target: { kind: "direction", label: "Площадки" },
  projects: [],
  indicators: [
    {
      card: indicator,
      definition: "Число действующих площадок",
      scope: { kind: "campus" },
      unit: "площадок",
      plan: { status: "missing" },
      actual: {
        status: "confirmed",
        value: 0,
        date: "2026-09-30",
        source: { card: document, clauseLocator: "1.2" },
      },
    },
  ],
};

test(
  "блок стратегии открывается клавиатурой и показывает загрузку, ошибки, пустую и заполненную справку",
  { timeout: 90_000 },
  async () => {
    const browser = await chromium.launch({
      channel: process.env.CAMPUS_QA_CHROME_CHANNEL || "chrome",
    });
    try {
      const page = await browser.newPage({
        storageState,
        reducedMotion: "reduce",
        viewport: { width: 390, height: 900 },
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let optionRequests = 0;
      let releaseLoad = () => {};
      const firstLoad = new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      await page.route(`${origin}/api/strategy/options`, async (route) => {
        optionRequests += 1;
        if (optionRequests === 1) {
          await firstLoad;
          await route.fulfill({
            status: 503,
            json: { error: "Фикстура недоступна" },
          });
        } else {
          await route.fulfill({ json: options });
        }
      });
      const requests: unknown[] = [];
      await page.route(`${origin}/api/analytics`, async (route) => {
        requests.push(route.request().postDataJSON());
        if (requests.length === 1) {
          await route.fulfill({
            status: 404,
            json: {
              error:
                "Документ или фильтр недоступен. Обновите список документов.",
            },
          });
        } else {
          await route.fulfill({ json: report });
        }
      });

      await page.goto(`${origin}/analytics`);
      assert.equal(
        new URL(page.url()).pathname,
        "/analytics",
        "Понадобится сессия сотрудника из изолированной фикстуры"
      );
      const disclosure = page
        .locator("summary")
        .filter({ hasText: "Стратегия и показатели" });
      await disclosure.focus();
      await page.keyboard.press("Enter");
      await page.getByText("Загружаем документы…", { exact: true }).waitFor();
      releaseLoad();
      await page
        .getByRole("alert")
        .filter({ hasText: "Фикстура недоступна" })
        .waitFor();
      await page.getByRole("button", { name: "Повторить загрузку" }).click();

      for (const retry of [false, true]) {
        const documentPicker = page.getByRole("combobox", { name: "Документ" });
        await documentPicker.press("Enter");
        await page
          .getByRole("option", { name: document.title, exact: true })
          .click();
        const filter = page.getByRole("combobox", {
          name: "Пункт или направление",
        });
        await filter.press("Enter");
        await page
          .getByRole("option", { name: "Площадки", exact: true })
          .waitFor();
        await page.keyboard.press("Escape");
        await page.waitForFunction(
          () => window.document.activeElement?.id === "strategy-target"
        );
        await filter.press("Enter");
        await page
          .getByRole("option", { name: "Площадки", exact: true })
          .click();
        await page.getByRole("button", { name: "Собрать справку" }).click();
        if (!retry) {
          await page
            .getByRole("alert")
            .filter({ hasText: "Документ или фильтр недоступен" })
            .waitFor();
          await page
            .getByRole("button", { name: "Обновить список документов" })
            .click();
        }
      }

      await page.getByText("Связанных проектов нет", { exact: true }).waitFor();
      await page
        .getByText("Нет подтверждённых данных", { exact: true })
        .waitFor();
      await page.getByText(/^0 площадок$/).waitFor();
      assert.match(
        (await page
          .getByRole("link", { name: indicator.title })
          .getAttribute("href")) ?? "",
        new RegExp(indicator.versionId)
      );
      assert.match(
        (await page
          .getByRole("link", { name: /пункт 1\.2/i })
          .getAttribute("href")) ?? "",
        new RegExp(document.versionId)
      );
      assert.deepEqual(
        requests,
        [0, 1].map(() => ({
          mode: "strategy",
          documentId: document.cardId,
          documentVersionId: document.versionId,
          target: { kind: "direction", id: "facilities" },
        }))
      );

      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(
          await page.evaluate(
            () => window.document.documentElement.scrollWidth > innerWidth + 1
          ),
          false,
          `ширина ${width}`
        );
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);
