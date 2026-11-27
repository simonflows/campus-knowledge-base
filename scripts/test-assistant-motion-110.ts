import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium, type Locator } from "playwright-core";

const base = "http://localhost:8080";
const assistantName = "Помощник Канона";
const responseText = "Ответ из локальной проверки помощника.";

async function waitForMotion(locator: Locator, description: string) {
  const element = await locator.elementHandle();
  assert.ok(element, description);
  await locator
    .page()
    .waitForFunction(
      (node) =>
        node.getAnimations().some((animation) => {
          const duration = animation.effect?.getComputedTiming().activeDuration;
          return (
            typeof duration === "number" && duration >= 300 && duration <= 500
          );
        }),
      element,
      { timeout: 1500 }
    )
    .catch(() => assert.fail(description));
  return element;
}

test("the assistant opens, shows a fresh reply and closes with motion", async () => {
  const browser = await chromium.launch({
    channel: process.env.CAMPUS_QA_CHROME_CHANNEL ?? "chrome",
  });
  try {
    const page = await browser.newPage({ reducedMotion: "no-preference" });
    await page.route("**/api/assistant", (route) =>
      route.fulfill({
        json: {
          status: "ready",
          message: responseText,
          citations: [],
          actions: [],
        },
      })
    );
    await page.goto(base + "/login");

    const launcher = page.getByRole("button", {
      name: "Открыть помощник Канона",
    });
    const popup = page.getByRole("dialog", { name: assistantName });
    await launcher.click({ trial: true });
    await launcher.focus();
    await page.keyboard.press("Enter");
    const panel = await waitForMotion(
      popup,
      "Opening should play a panel transition"
    );
    await panel.evaluate((node) =>
      Promise.allSettled(
        node.getAnimations().map((animation) => animation.finished)
      )
    );
    assert.equal(
      await popup
        .getByRole("heading", { name: assistantName })
        .evaluate((node) => node === document.activeElement),
      true
    );

    const composer = popup.getByRole("textbox", {
      name: "Вопрос помощнику Канона",
    });
    await composer.fill("Вопрос для локальной проверки");
    const request = page.waitForRequest(
      (request) => new URL(request.url()).pathname === "/api/assistant"
    );
    await composer.press("Enter");
    assert.equal((await request).method(), "POST");
    const answer = popup.getByText(responseText, { exact: true });
    await answer.waitFor();
    const replyIsRevealing = await answer.evaluate((node) => {
      const turn = node.closest("article");
      return turn?.getAnimations({ subtree: true }).some((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        const duration = animation.effect?.getComputedTiming().activeDuration;
        return (
          target instanceof Element &&
          target !== turn &&
          target.contains(node) &&
          typeof duration === "number" &&
          duration >= 300 &&
          duration <= 500
        );
      });
    });
    assert.ok(
      replyIsRevealing,
      "An answer should reveal itself even when the API responds immediately"
    );

    const closing = page.waitForFunction(
      (node) =>
        node.isConnected &&
        node.getAnimations().some((animation) => {
          const duration = animation.effect?.getComputedTiming().activeDuration;
          return (
            typeof duration === "number" && duration >= 300 && duration <= 500
          );
        }),
      panel,
      { timeout: 1500 }
    );
    await page.keyboard.press("Escape");
    await closing.catch(() =>
      assert.fail("Closing should play a panel transition before unmounting")
    );
    await popup.waitFor({ state: "hidden" });
    assert.equal(
      await launcher.evaluate((node) => node === document.activeElement),
      true
    );
  } finally {
    await browser.close();
  }
});

test("reduced motion keeps the mobile dialog still and closing cancels a pending request", async () => {
  const browser = await chromium.launch({
    channel: process.env.CAMPUS_QA_CHROME_CHANNEL ?? "chrome",
  });
  try {
    const page = await browser.newPage({
      reducedMotion: "reduce",
      viewport: { width: 320, height: 680 },
    });
    let releaseResponse: () => void = () => {};
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    await page.route("**/api/assistant", async (route) => {
      await responseGate;
      await route.fulfill({
        json: {
          status: "ready",
          message: responseText,
          citations: [],
          actions: [],
        },
      });
    });
    await page.goto(base + "/login");

    const launcher = page.getByRole("button", {
      name: "Открыть помощник Канона",
    });
    const popup = page.getByRole("dialog", { name: assistantName });
    await launcher.click();
    await popup.waitFor();
    const panel = await popup.evaluate((node) => {
      const { x, y, right, bottom } = node.getBoundingClientRect();
      const durations = node
        .getAnimations({ subtree: true })
        .map(
          (animation) => animation.effect?.getComputedTiming().activeDuration
        );
      return { x, y, right, bottom, durations };
    });
    assert.ok(
      panel.x > 0 && panel.y >= 0 && panel.right < 320 && panel.bottom <= 680
    );
    assert.ok(panel.durations.every((duration) => Number(duration) <= 1));

    const composer = popup.getByRole("textbox", {
      name: "Вопрос помощнику Канона",
    });
    await composer.fill("Вопрос до закрытия помощника");
    await composer.press("Enter");
    await popup
      .getByText("Сверяю утверждённые карточки", { exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await popup.waitFor({ state: "hidden" });
    releaseResponse();

    assert.equal(
      await launcher.evaluate((node) => node === document.activeElement),
      true
    );
    await page.keyboard.press("Enter");
    await popup.getByText("Запрос отменён.", { exact: true }).waitFor();
    assert.equal(
      await popup.getByText(responseText, { exact: true }).count(),
      0
    );
    assert.ok(
      await popup.getByRole("button", { name: "Повторить запрос" }).isEnabled()
    );
  } finally {
    await browser.close();
  }
});
