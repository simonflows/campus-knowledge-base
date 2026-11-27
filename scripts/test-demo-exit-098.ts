import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { BROWSER_DEMO_KEY } from "../lib/browser-demo";

test("retired demo redirects to real login and preserves existing browser data", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.goto("http://localhost:8080/login");
    await page.evaluate((key) => localStorage.setItem(key, "retained-legacy-demo-data"), BROWSER_DEMO_KEY);
    for (const width of [320,390,1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("http://localhost:8080/demo?old=1#/check?draft=legacy");
      const url = new URL(page.url());
      assert.equal(url.pathname, "/login");
      assert.equal(url.search, "");
      assert.equal(url.hash, "");
      assert.equal(await page.getByRole("link", { name: /Попробовать.*демо|Выйти из демо/ }).count(), 0);
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), BROWSER_DEMO_KEY), "retained-legacy-demo-data");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
  } finally { await browser.close(); }
});
