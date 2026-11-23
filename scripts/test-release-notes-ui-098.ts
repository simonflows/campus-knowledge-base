import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { version } from "../package.json";

export async function runReleaseNotesUiChecks(page: Page, base: string) {
  await page.goto(base + "/demo");
  await page.setViewportSize({ width: 390, height: 844 });
  const trigger = page.getByRole("button", {
    name: `Версия ${version} — что нового`,
    exact: true,
  });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: `Канон ${version}`,
    exact: true,
  });
  await dialog.waitFor();
  assert.equal(await dialog.getByRole("listitem").count(), 4);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth
    ),
    false
  );
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(
    await trigger.evaluate((element) => element === document.activeElement),
    true
  );
}
