import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

test(
  "masthead keeps the sweeping arcs and moves their geometry, while reduced motion stays still",
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage({
        viewport: { width: 1280, height: 900 },
      });
      for (const path of ["/requests", "/login"]) {
        await page.goto("http://localhost:8080" + path);
        const field = page.locator("[data-masthead-contours]");
        await field.locator("canvas").waitFor();
        await page.waitForFunction(
          () =>
            document
              .querySelector("[data-masthead-contours]")
              ?.getAttribute("data-paused") === "false"
        );
        const canvas = field.locator("canvas");
        const before = await canvas.evaluate((c) =>
          (c as HTMLCanvasElement).toDataURL()
        );
        await page.waitForTimeout(600);
        assert.notEqual(
          await canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL()),
          before,
          "Actual pixels change, not just the canvas position"
        );
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.waitForFunction(
          () =>
            document
              .querySelector("[data-masthead-contours]")
              ?.getAttribute("data-paused") === "true"
        );
        const still = await canvas.evaluate((c) =>
          (c as HTMLCanvasElement).toDataURL()
        );
        await page.waitForTimeout(250);
        assert.equal(
          await canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL()),
          still
        );
        await page.screenshot({
          path:
            ".playwright-cli/masthead-120-" + path.slice(1) + "-reduced.png",
        });
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.screenshot({
          path: ".playwright-cli/masthead-120-" + path.slice(1) + ".png",
        });
      }
    } finally {
      await browser.close();
    }
  }
);
