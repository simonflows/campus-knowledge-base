import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Page } from "playwright-core";

const demoUrl = "http://localhost:8080/demo";

async function readContours(page: Page) {
  return page.locator("[data-home-topography]").evaluate((field) => {
    const canvases = [...field.querySelectorAll("canvas")];
    if (!canvases.length) {
      return [...field.querySelectorAll("path")].map((path) => ({
        shape: path.getAttribute("d"),
        pixels: 1,
      }));
    }
    return canvases.map((canvas) => {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Expected a 2D contour drawing");
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      let pixels = 0;
      for (let alpha = 3; alpha < rgba.length; alpha += 4) {
        if (rgba[alpha] === 0) continue;
        hash = Math.imul(hash ^ alpha, 16777619);
        pixels++;
      }
      return { shape: String(hash), pixels };
    });
  });
}

test(
  "the visible home contours move and remain still offscreen and with reduced motion",
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 3,
      });
      await page.goto(demoUrl);
      const field = page.locator("[data-home-topography]");
      await field.waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const layers = [
          ...document.querySelectorAll<HTMLCanvasElement>(
            "[data-home-topography] canvas"
          ),
        ];
        return layers.every((canvas) => canvas.height !== 150);
      });
      const startingDrawing = await readContours(page);
      await page.waitForTimeout(1_100);
      const movingDrawing = await readContours(page);
      assert.ok(
        startingDrawing.length > 1 &&
          startingDrawing.every(({ pixels }) => pixels > 0),
        "Both edge groups must be rendered"
      );
      assert.ok(
        startingDrawing.every(
          ({ shape }, index) => shape !== movingDrawing[index].shape
        ),
        "Both edge drawings must change their contour geometry, independently of layer transforms"
      );
      const sizes = await field.locator("canvas").evaluateAll((layers) =>
        layers.map((canvas) => {
          if (!(canvas instanceof HTMLCanvasElement))
            throw new Error("Expected canvas layer");
          return {
            pixels: canvas.width * canvas.height,
            ratio: canvas.width / canvas.clientWidth,
          };
        })
      );
      assert.equal(sizes.length, 2);
      assert.ok(
        sizes.every(({ pixels, ratio }) => pixels <= 700_000 && ratio <= 1.5)
      );

      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", {
          configurable: true,
          value: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const hiddenDrawing = await readContours(page);
      await page.waitForTimeout(350);
      assert.deepEqual(await readContours(page), hiddenDrawing);
      await page.evaluate(() => {
        Reflect.deleteProperty(document, "hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.waitForTimeout(350);
      assert.notDeepEqual(await readContours(page), hiddenDrawing);

      await page.evaluate(() =>
        window.scrollTo({
          top: document.body.scrollHeight,
          behavior: "instant",
        })
      );
      await page.waitForFunction(
        () =>
          (document
            .querySelector("[data-home-topography]")
            ?.getBoundingClientRect().bottom ?? Infinity) < 0
      );
      await page.waitForTimeout(180);
      const offscreenDrawing = await readContours(page);
      await page.waitForTimeout(300);
      assert.deepEqual(await readContours(page), offscreenDrawing);

      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.evaluate(() =>
        window.scrollTo({ top: 0, behavior: "instant" })
      );
      await page.waitForTimeout(180);
      const staticDrawing = await readContours(page);
      assert.equal(
        staticDrawing.filter(({ pixels }) => pixels > 0).length,
        2,
        "Reduced motion retains both drawings"
      );
      await page.waitForTimeout(500);
      assert.deepEqual(await readContours(page), staticDrawing);

      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.waitForTimeout(500);
      assert.notDeepEqual(await readContours(page), staticDrawing);

      await page.evaluate(() => {
        document.documentElement.dataset.motion = "off";
      });
      await page.waitForTimeout(180);
      assert.deepEqual(await readContours(page), staticDrawing);
    } finally {
      await browser.close();
    }
  }
);

test(
  "home capacity keeps both counts with their own labels",
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage({ reducedMotion: "reduce" });
      await page.goto(demoUrl);
      const capacity = page
        .locator(".atlas-passport .atlas-metric-card")
        .filter({ hasText: "Вместимость и контингент" });
      await capacity.waitFor();
      const values = capacity.locator(".atlas-home-metric-part");
      const text = await values.allTextContents();
      assert.deepEqual(
        text.map((value) => value.replace(/\s+/g, " ").trim()),
        ["3 400 мест проживания", "5 000 обучающихся"]
      );
      assert.equal(
        await values.first().evaluate((row) => getComputedStyle(row).display),
        "flex",
        "A count and its caption have a dedicated responsive row"
      );
      for (const width of [320, 390, 1024, 1440]) {
        await page.setViewportSize({ width, height: 850 });
        assert.ok(
          await values.evaluateAll((rows) =>
            rows.every((row) => {
              const number = row.firstElementChild;
              const numberRect = number?.getBoundingClientRect();
              const rowRect = row.getBoundingClientRect();
              return (
                numberRect &&
                numberRect.width <= rowRect.width &&
                numberRect.x >= rowRect.x
              );
            })
          )
        );
        assert.ok(
          await capacity.evaluate(
            (card) => card.scrollWidth <= card.clientWidth
          )
        );
      }
      const context = page.locator(".atlas-passport-context");
      assert.match(
        await context.innerText(),
        /проектируется 40–44 лаборатории/
      );
    } finally {
      await browser.close();
    }
  }
);
