import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

const origin = process.env.CAMPUS_UI_ORIGIN || "http://localhost:8080";
const sentences = [
  "Первая очередь гостиниц кампуса рассчитана на 336 мест.",
  "Вторая очередь гостиниц кампуса рассчитана на 3 064 места.",
  "Общая вместимость гостиниц кампуса составляет 3 400 мест.",
  "Межуниверситетский кампус «Южный Урал» строится в Челябинске.",
];

test(
  "public pages, backgrounds, retired demo and reduced motion work at supported widths",
  { timeout: 120_000 },
  async () => {
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        for (const path of [
          "/",
          "/login",
          "/knowledge",
          "/requests",
          "/check",
          "/analytics",
        ]) {
          await page.goto(origin + path);
          await page.locator("h1").first().waitFor();
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth > innerWidth + 1
            ),
            false,
            `${path} at ${width}`
          );
          assert.equal(await page.locator('a[href="/demo"]').count(), 0);
          const field = page.locator(".atlas-ambient-bg");
          assert.equal(await field.getAttribute("aria-hidden"), "true");
          assert.equal(await field.locator("svg").count(), 2);
          assert.equal(
            await field.evaluate(
              (node) => getComputedStyle(node).pointerEvents
            ),
            "none"
          );
        }
      }
      await page.goto(origin + "/demo?retired=1#/check?private=old");
      assert.equal(new URL(page.url()).pathname, "/login");
      assert.equal(new URL(page.url()).search, "");
      assert.equal(new URL(page.url()).hash, "");
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          value: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForFunction(
        () =>
          document
            .querySelector(".atlas-ambient-bg")
            ?.getAttribute("data-paused") === "true"
      );
      assert.equal(
        await page
          .locator(".atlas-ambient-bg > div")
          .first()
          .evaluate((node) => getComputedStyle(node).transitionDuration),
        "0s"
      );
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          value: false,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(() =>
        [...document.querySelectorAll("[data-relief-layer]")].every((node) =>
          node
            .getAnimations()
            .every((animation) => animation.playState === "paused")
        )
      );
      await page.evaluate(() =>
        Promise.all(
          [...document.querySelectorAll("[data-relief-layer]")].flatMap(
            (node) =>
              node
                .getAnimations()
                .map((animation) => animation.ready.then(() => undefined))
          )
        )
      );
      const layers = page.locator("[data-relief-layer]");
      const before = await layers.evaluateAll((nodes) =>
        nodes.map((node) =>
          Array.from(
            new DOMMatrixReadOnly(
              getComputedStyle(node).transform === "none"
                ? undefined
                : getComputedStyle(node).transform
            ).toFloat64Array()
          )
        )
      );
      await page.waitForTimeout(150);
      assert.deepEqual(
        await layers.evaluateAll((nodes) =>
          nodes.map((node) =>
            Array.from(
              new DOMMatrixReadOnly(
                getComputedStyle(node).transform === "none"
                  ? undefined
                  : getComputedStyle(node).transform
              ).toFloat64Array()
            )
          )
        ),
        before
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
);

test(
  "real local fact API keeps verdicts for equivalent layouts; background acknowledges waiting",
  { timeout: 90_000 },
  async () => {
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      await page.goto(origin + "/check");
      const layouts = [
        sentences.join("\n\n"),
        sentences.join(" "),
        sentences.map((s) => "- " + s).join("\n"),
        sentences.toReversed().join("\n"),
        sentences
          .join(" ")
          .replaceAll("3 0", "3\u202f0")
          .replaceAll("3 4", "3\u00a04"),
      ];
      const summaries: unknown[] = [];
      for (const text of layouts) {
        const result = await page.evaluate(async (body) => {
          const response = await fetch("/api/fact-check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: body, useAi: false }),
          });
          return { status: response.status, data: await response.json() };
        }, text);
        assert.equal(result.status, 200);
        summaries.push(result.data.summary);
      }
      summaries.forEach((summary, index) =>
        assert.deepEqual(summary, summaries[0], `Equivalent layout ${index}`)
      );
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/api/fact-check", async (route) => {
        await pending;
        await route.continue();
      });
      try {
        await page
          .getByRole("textbox", { name: "Черновик текста" })
          .fill(layouts[1]);
        await page
          .getByRole("button", { name: "Проверить текст", exact: true })
          .click();
        await page.waitForFunction(
          () => !!document.querySelector('main [aria-busy="true"]')
        );
        await page.waitForFunction(
          () =>
            Number(
              getComputedStyle(document.querySelector("[data-relief-layer]")!)
                .opacity
            ) > 0.2
        );
      } finally {
        release();
      }
      await page.waitForFunction(
        () => !document.querySelector('main [aria-busy="true"]')
      );
      await page
        .getByRole("heading", { name: "Итог проверки", exact: true })
        .waitFor();
    } finally {
      await browser.close();
    }
  }
);
