import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";

test("an assistant control cannot lose an early activation before React is ready", async () => {
  const browser = await chromium.launch({
    channel: process.env.CAMPUS_QA_CHROME_CHANNEL || "chrome",
  });
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.goto("http://localhost:8080/login");
    const trigger = page.getByRole("button", {
      name: "Открыть помощник Канона",
    });
    assert.equal(await trigger.isDisabled(), true);
    assert.equal(await page.getByRole("dialog").count(), 0);
  } finally {
    await browser.close();
  }
});
