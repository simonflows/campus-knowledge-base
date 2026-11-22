import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { Page } from "playwright-core";
import { readBrowserDemo } from "../lib/browser-demo";
import { createBrowserDemoRequest } from "../lib/browser-demo-http";
import { handleDemoTools } from "../lib/browser-demo-tools";

const rewriteButton = "Переписать по официальным данным";
const rewriteHeading = "Текст, переписанный по официальным данным";

async function checkDemoRewrite(page: Page, base: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (options) {
      if (this instanceof HTMLHeadingElement) {
        this.dataset.testScrollBehavior =
          typeof options === "object" ? options.behavior : "auto";
      }
      original.call(this, options);
    };
  });

  await page.goto(base + "/demo#/check");
  const draft = page.getByRole("textbox", { name: "Черновик текста" });
  const check = page.getByRole("button", { name: "Проверить текст" });
  const rewrite = page.getByRole("button", { name: rewriteButton });
  const proposal = page.getByRole("heading", { name: rewriteHeading });
  const analysis = page.getByRole("heading", { name: "Разбор по уровням" });
  const originalWarning = page.getByText("Публикация запрещена до правки", {
    exact: true,
  });

  await page.getByRole("button", { name: "Пример текста" }).click();
  await check.click();
  await analysis.waitFor();
  assert.equal(await proposal.count(), 0);
  assert.equal(await page.locator("[data-test-scroll-behavior]").count(), 0);
  assert.ok(
    await page
      .getByText("Каждое замечание содержит источник", { exact: false })
      .isVisible()
  );

  await rewrite.click();
  await proposal.waitFor();
  assert.ok(
    await proposal.evaluate((heading) => {
      const headings = Array.from(document.querySelectorAll("h2"));
      const analysis = headings.find((item) =>
        item.textContent?.includes("Разбор по уровням")
      );
      return (
        analysis &&
        Boolean(
          heading.compareDocumentPosition(analysis) &
          Node.DOCUMENT_POSITION_FOLLOWING
        )
      );
    }),
    "the rewritten text must come before the detailed analysis"
  );
  await page.waitForFunction(
    () => document.activeElement instanceof HTMLHeadingElement
  );
  assert.equal(
    await proposal.getAttribute("data-test-scroll-behavior"),
    "instant"
  );
  assert.deepEqual(
    await proposal.evaluate((heading) => {
      const header = document.querySelector("header.atlas-header");
      const bounds = heading.getBoundingClientRect();
      return {
        focused: document.activeElement === heading,
        visible:
          !!header &&
          bounds.top >= header.getBoundingClientRect().bottom &&
          bounds.bottom <= innerHeight,
        fits:
          document.documentElement.scrollWidth ===
          document.documentElement.clientWidth,
      };
    }),
    { focused: true, visible: true, fits: true }
  );

  assert.ok(await originalWarning.isVisible());
  assert.ok(
    await page.getByText("Что требует сверки в исходном тексте").isVisible()
  );
  assert.ok(await page.getByText("Карточки-источники").isVisible());
  assert.ok(
    await page.getByRole("button", { name: "Скопировать текст" }).isVisible()
  );

  const saved = page.waitForEvent("download");
  await page.getByRole("button", { name: "Скачать .md" }).click();
  const download = await saved;
  assert.equal(download.suggestedFilename(), "campus-canonical-rewrite.md");
  assert.match(
    await readFile(await download.path(), "utf8"),
    /Официальные источники: /u
  );

  const disclosure = page.locator("details", { has: analysis });
  assert.equal(await disclosure.getAttribute("open"), null);
  const summary = disclosure.locator("summary");
  await summary.press("Enter");
  assert.equal(await disclosure.getAttribute("open"), "");
  await summary.press("Space");
  assert.equal(await disclosure.getAttribute("open"), null);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await rewrite.click();
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-test-scroll-behavior") ===
      "smooth"
  );

  await draft.fill(
    "Кедровая шишка упала на опушке, где виднеются заросли черники."
  );
  assert.equal(await proposal.count(), 0);
  assert.equal(await page.locator("[data-test-scroll-behavior]").count(), 0);
  await rewrite.click();
  await page.getByText("Переписать не удалось", { exact: true }).waitFor();
  assert.equal(await page.locator("[data-test-scroll-behavior]").count(), 0);
  assert.equal(
    await proposal.evaluate((heading) => document.activeElement === heading),
    false
  );
}

async function checkWorkingRewrite(page: Page, base: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const readJson = Response.prototype.json;
    Response.prototype.json = async function () {
      const data = await readJson.call(this);
      const dataset = document.documentElement.dataset;
      if (data?.rewrite?.plainText && dataset.testHoldRewrite === "yes") {
        await new Promise<void>((resolve) => {
          window.addEventListener("test-release-rewrite", () => resolve(), {
            once: true,
          });
          dataset.testHoldRewrite = "waiting";
        });
        dataset.testHoldRewrite = "released";
      }
      return data;
    };
  });

  const storage = { getItem: () => null, setItem: () => {} };
  const fixture = createBrowserDemoRequest(storage, readBrowserDemo(storage), [
    handleDemoTools,
  ]);
  let unavailable = false;
  await page.route("**/api/fact-check", async (route) => {
    if (unavailable) {
      await route.fulfill({
        status: 503,
        json: { error: "Сбой тестовой проверки." },
      });
      return;
    }
    const response = await fixture("/api/fact-check", {
      method: route.request().method(),
      body: route.request().postData(),
    });
    await route.fulfill({
      status: response.status,
      json: await response.json(),
    });
  });

  await page.goto(base + "/check");
  const draft = page.getByRole("textbox", { name: "Черновик текста" });
  const rewrite = page.getByRole("button", { name: rewriteButton });
  const sample = page.getByRole("button", { name: "Пример текста" });
  const proposal = page.getByRole("heading", { name: rewriteHeading });
  await sample.click();
  await page.evaluate(() => {
    document.documentElement.dataset.testHoldRewrite = "yes";
  });
  await rewrite.click();
  await page.waitForFunction(
    () => document.documentElement.dataset.testHoldRewrite === "waiting"
  );
  await draft.fill(
    "Кедровая шишка упала на опушке, где виднеются заросли черники."
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event("test-release-rewrite"))
  );
  await page.waitForFunction(
    () => document.documentElement.dataset.testHoldRewrite === "released"
  );
  assert.equal(await proposal.count(), 0);
  assert.ok(await draft.evaluate((field) => document.activeElement === field));

  unavailable = true;
  await rewrite.click();
  await page
    .getByText("Сбой тестовой проверки.", { exact: true })
    .first()
    .waitFor();
  assert.equal(await proposal.count(), 0);

  unavailable = false;
  await sample.click();
  await rewrite.click();
  await proposal.waitFor();
  await page.waitForFunction(() =>
    document.activeElement?.textContent?.includes(
      "Текст, переписанный по официальным данным"
    )
  );
}

export async function runFactResultUiChecks(page: Page, base: string) {
  await checkDemoRewrite(page, base);
  await checkWorkingRewrite(page, base);
}
