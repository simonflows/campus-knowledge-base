import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

test(
  "the page background has no pattern and only responds softly while work is pending",
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      await page.goto("http://localhost:8080/check");
      const field = page.locator(".atlas-ambient-bg");
      assert.equal(
        await field.locator("svg,canvas").count(),
        0,
        "No drawn contour or pattern behind the page"
      );
      assert.equal(
        await field.evaluate((node) => Number(getComputedStyle(node).opacity)),
        0,
        "Idle surface stays neutral"
      );
      assert.equal(
        await field.evaluate((node) => getComputedStyle(node).pointerEvents),
        "none"
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
          .getByRole("textbox", { name: "Черновик текста", exact: true })
          .fill(
            "Межуниверситетский кампус «Южный Урал» строится в Челябинске."
          );
        await page
          .getByRole("button", { name: "Проверить текст", exact: true })
          .click();
        await page.waitForFunction(
          () =>
            document
              .querySelector(".atlas-ambient-bg")
              ?.getAttribute("data-active") === "true"
        );
        await page.waitForFunction(
          () =>
            Number(
              getComputedStyle(document.querySelector(".atlas-ambient-bg")!)
                .opacity
            ) > 0.95
        );
        assert.equal(await field.locator("svg,canvas").count(), 0);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.waitForFunction(
          () =>
            document
              .querySelector(".atlas-ambient-bg")
              ?.getAttribute("data-paused") === "true"
        );
        assert.equal(
          await field.evaluate((node) =>
            node
              .getAnimations({ subtree: true })
              .some((a) => a.playState === "running")
          ),
          false
        );
        assert.ok(
          await page
            .getByRole("button", { name: "Остановить", exact: true })
            .isVisible()
        );
      } finally {
        release();
      }
      await page.waitForFunction(
        () =>
          document
            .querySelector(".atlas-ambient-bg")
            ?.getAttribute("data-active") === "false"
      );
      await page.waitForFunction(
        () =>
          Number(
            getComputedStyle(document.querySelector(".atlas-ambient-bg")!)
              .opacity
          ) === 0
      );
    } finally {
      await browser.close();
    }
  }
);
