import { chromium } from "playwright-core";
import { runFactResultUiChecks } from "./test-fact-result-ui-097";
import { runFactReportUiChecks } from "./test-fact-report-ui-098";
import { runAssistantUiChecks } from "./test-assistant-ui-098";
import { runReleaseNotesUiChecks } from "./test-release-notes-ui-098";
import { runFactStreamUiChecks } from "./test-fact-stream-ui-098";

async function main() {
  const browser = await chromium.launch({
    channel: process.env.CAMPUS_QA_CHROME_CHANNEL ?? "chrome",
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await runFactResultUiChecks(page, "http://localhost:8080");
    await runFactReportUiChecks(page, "http://localhost:8080");
    const assistant = await context.newPage();
    await runAssistantUiChecks(assistant, "http://localhost:8080");
    await runReleaseNotesUiChecks(assistant, "http://localhost:8080");
    const streamed = await context.newPage();
    await runFactStreamUiChecks(streamed, "http://localhost:8080");
    console.log(
      "PASS: rewrite ordering/focus, stale requests, limited coverage, AI fallback, assistant keyboard, release notes and fact stream recovery"
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
