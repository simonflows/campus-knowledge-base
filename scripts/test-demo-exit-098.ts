import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

const localOrigin = "http://localhost:8080";
const exitLabel = "Выйти из демо";

test(
  "the demo header has a complete, usable exit link at all supported widths",
  { timeout: 60_000 },
  async () => {
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 900 },
      });
      await page.goto(`${localOrigin}/login`);
      await page
        .getByRole("link", { name: /Попробовать в демо-режиме/ })
        .click();
      const header = page.getByRole("banner");
      const exit = header.getByRole("link", { name: exitLabel, exact: true });
      await exit.waitFor();
      const target = await exit.getAttribute("href");
      assert.equal(target, "/");

      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const measured = await exit.evaluate((link) => {
          if (!(link instanceof HTMLAnchorElement))
            throw new Error("Expected exit link");
          const rect = link.getBoundingClientRect();
          const headerRect = link.closest("header")?.getBoundingClientRect();
          const elementAtCenter = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2
          );
          return {
            ariaLabel: link.getAttribute("aria-label"),
            spans: link.querySelectorAll("span").length,
            text: link.innerText,
            icon: Boolean(link.querySelector("svg")),
            width: rect.width,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            gap: parseFloat(getComputedStyle(link).columnGap),
            hit: link.contains(elementAtCenter),
            fitsHeader:
              headerRect &&
              headerRect.left <= rect.left &&
              headerRect.right >= rect.right,
          };
        });
        console.log(width, measured);
        assert.equal(measured.text, exitLabel, `${width}px: visible link text`);
        assert.ok(measured.icon, `${width}px: visible exit icon`);
        assert.ok(
          measured.gap >= 6,
          `${width}px: spacing between exit icon and label`
        );
        assert.ok(
          measured.width >= 44 && measured.height >= 44,
          `${width}px: 44px hit area`
        );
        assert.ok(
          measured.left >= 0 &&
            measured.right <= width &&
            measured.fitsHeader &&
            measured.hit,
          `${width}px: link fits in viewport`
        );
        assert.equal(
          await header.getByText("Демо", { exact: true }).isVisible(),
          true
        );
      }

      const idleColor = await exit.evaluate(
        (link) => getComputedStyle(link).backgroundColor
      );
      await exit.hover();
      await page.waitForFunction((color) => {
        const link = document.querySelector("header .atlas-demo-exit");
        return link && getComputedStyle(link).backgroundColor !== color;
      }, idleColor);
      await page.mouse.move(0, 0);
      for (let step = 0; step < 15; step++) {
        await page.keyboard.press("Tab");
        if (await exit.evaluate((link) => link === document.activeElement))
          break;
      }
      assert.equal(
        await exit.evaluate((link) => {
          const style = getComputedStyle(link);
          return (
            link === document.activeElement &&
            link.matches(":focus-visible") &&
            style.outlineStyle !== "none" &&
            parseFloat(style.outlineWidth) >= 2
          );
        }),
        true
      );
      await page.keyboard.press("Enter");
      await page.waitForURL(new URL(target, localOrigin).href);
    } finally {
      await browser.close();
    }
  }
);
