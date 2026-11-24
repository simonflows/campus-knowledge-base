import { chromium, type Page } from "playwright-core";
import {
  BROWSER_DEMO_KEY,
  getDemoCard,
  readBrowserDemo,
  writeBrowserDemo,
} from "../lib/browser-demo";
import candidateData from "../data/pilot-0.9.5-candidates.json";
import { version } from "../package.json";

async function checkUi099(
  page: Page,
  fixture: { key: string; value: string; version: string }
) {
  const failures: string[] = [];
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(({ key, value }) => {
    if (
      location.origin === "http://localhost:8080" &&
      location.pathname === "/demo"
    ) {
      localStorage.setItem(key, value);
    }
  }, fixture);
  await page.goto("http://localhost:8080/demo");
  const trigger = page.getByRole("button", {
    name: `Версия ${fixture.version} — что нового`,
    exact: true,
  });
  const launcher = page.getByRole("button", {
    name: "Открыть помощник Канона",
  });
  await trigger.waitFor();

  const glyphs = [];
  for (const label of ["Первая очередь гостиниц", "Вторая очередь гостиниц"]) {
    const card = page.locator(".atlas-metric-card").filter({
      has: page.locator("dt", { hasText: label }),
    });
    await card.waitFor();
    const icons = await card
      .locator(".atlas-metric-icon svg")
      .evaluateAll((elements) => elements.map((element) => element.innerHTML));
    if (icons.length !== 1)
      failures.push(`${label}: expected one glyph, found ${icons.length}`);
    glyphs.push(icons[0]);
  }
  if (glyphs[0] === glyphs[1])
    failures.push("The two stages show identical glyphs");

  const readContrast = () =>
    trigger.evaluate(async (button) => {
      await Promise.all(
        button.getAnimations().map((animation) => animation.finished)
      );
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable");
      const style = getComputedStyle(button);
      const footer = button.closest("footer");
      if (!footer) throw new Error("Version trigger is outside the footer");
      const surface =
        style.backgroundColor === "rgba(0, 0, 0, 0)"
          ? getComputedStyle(footer).backgroundColor
          : style.backgroundColor;
      const light = [style.color, surface].map((color) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const rgb = context.getImageData(0, 0, 1, 1).data;
        const [r, g, b] = [rgb[0], rgb[1], rgb[2]].map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      });
      return (Math.max(...light) + 0.05) / (Math.min(...light) + 0.05);
    });

  for (const width of [320, 390, 768, 1280, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.mouse.move(0, 0);
    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight)
    );
    const button = await trigger.boundingBox();
    const help =
      (await launcher.count()) === 1 ? await launcher.boundingBox() : null;
    if (!button || !help) {
      failures.push(
        `${width}px: expected one visible launcher and version button`
      );
      continue;
    }
    const overlap =
      button.x < help.x + help.width &&
      button.x + button.width > help.x &&
      button.y < help.y + help.height &&
      button.y + button.height > help.y;
    if (overlap) {
      failures.push(`${width}px: launcher overlaps the version button`);
    }
    if (
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth
      )
    ) {
      failures.push(`${width}px: unexpected horizontal scrolling`);
    }
    const normal = await readContrast();
    if (!overlap) await trigger.hover({ timeout: 3000 });
    const hovered = await trigger.evaluate((element) =>
      element.matches(":hover")
    );
    const hover = await readContrast();
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    await trigger.focus();
    const focused = await trigger.evaluate((element) => {
      const style = getComputedStyle(element);
      return (
        element.matches(":focus-visible") &&
        (style.outlineStyle !== "none" || style.boxShadow !== "none")
      );
    });
    const focus = await readContrast();
    console.log(
      `${width}px: contrast default/hover/focus ${[normal, hover, focus].map((value) => value.toFixed(2)).join("/")}`
    );
    if (Math.min(normal, hover, focus) < 4.5 || !hovered || !focused) {
      failures.push(
        `${width}px: version should meet 4.5:1 in default, hover and visible keyboard focus`
      );
    }
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", {
      name: `Канон ${fixture.version}`,
      exact: true,
    });
    await dialog.waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    if (
      !(await trigger.evaluate((element) => element === document.activeElement))
    ) {
      failures.push(
        `${width}px: closing release notes should return focus to the version`
      );
    }
    await trigger.blur();
  }

  if (failures.length) throw new Error(failures.join("\n"));
  return "PASS: distinct stage glyphs, version contrast and keyboard interaction, isolated launcher";
}

async function main() {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
  const demo = readBrowserDemo(storage);
  const passport = getDemoCard(demo, "campus-passport");
  const candidate = candidateData.cards.find(
    ({ card }) => card.id === "campus-passport"
  )?.card;
  if (passport?.type !== "campus" || !candidate?.campusMetrics) {
    throw new Error("Campus passport test fixture is unavailable");
  }
  demo.updates = [{ ...passport, campusMetrics: candidate.campusMetrics }];
  writeBrowserDemo(storage, demo);
  const value = data.get(BROWSER_DEMO_KEY);
  if (!value) throw new Error("Browser demo test fixture was not serialized");

  const browser = await chromium.launch({
    channel: process.env.CAMPUS_QA_CHROME_CHANNEL ?? "chrome",
  });
  try {
    const page = await browser.newPage();
    console.log(
      await checkUi099(page, { key: BROWSER_DEMO_KEY, value, version })
    );
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
