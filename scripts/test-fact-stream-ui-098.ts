import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { checkFactText } from "../lib/fact-check";
import { knowledgeSeedCards } from "../lib/knowledge";

/** Controlled streaming transport in a disposable page, never the working API. */
export async function runFactStreamUiChecks(page: Page, base: string) {
  const payload = checkFactText(
    "Мне нравится характер Челябинска. Каким будет образование?",
    knowledgeSeedCards
  );
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript({
    content: String.raw`
    Object.defineProperty(AbortSignal, 'any', {value: undefined, configurable: true});
    Object.defineProperty(AbortSignal, 'timeout', {value: undefined, configurable: true});
    window.__factStream098 = { cancelled: 0, emit: null };
    window.__originalFetch098 = window.fetch;
    window.fetch = async function(input, init) {
      const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname;
      if (path !== '/api/fact-check') return window.__originalFetch098.call(this, input, init);
      const encoder = new TextEncoder();
      let finished = false;
      const body = new ReadableStream({
        start(controller) {
          window.__factStream098.emit = function(mode) {
            if (finished) return;
            if (mode === 'truncated') { finished = true; controller.close(); return; }
            const row = mode === 'error' ? {type:'error',error:'Источники изменились во время проверки',status:409}
              : mode === 'invalid' ? {type:'result',result:{error:{unexpected:true}}}
              : mode === 'missing' ? {type:'result',result:{summary:{red:0,yellow:0,green:0,total:0},canPublish:false,findings:[],checkpoints:[]}}
              : {type:'result',result:${JSON.stringify(payload)}};
            controller.enqueue(encoder.encode(JSON.stringify(row)+'\n'));
            finished = true; controller.close();
          };
          controller.enqueue(encoder.encode(JSON.stringify({type:'progress',stage:'extract',completed:1,total:3})+'\n'));
          init?.signal?.addEventListener('abort', function() {
            window.__factStream098.cancelled++;
            if (!finished) { finished=true; controller.error(new DOMException('Aborted','AbortError')); }
          }, {once:true});
        },
        cancel() { finished=true; window.__factStream098.cancelled++; }
      });
      return new Response(body,{headers:{'Content-Type':'application/x-ndjson'}});
    };
  `,
  });
  await page.goto(base + "/check");
  const input = page.getByRole("textbox", { name: "Черновик текста" });
  const run = page.getByRole("button", {
    name: "Проверить текст",
    exact: true,
  });
  const progress = page.getByRole("status").filter({ hasText: /Этап 1 из 2/ });
  const coverage = page.getByRole("region", {
    name: "Охват проверки",
    exact: true,
  });
  const emit = (mode: string) =>
    page.evaluate(`window.__factStream098.emit(${JSON.stringify(mode)})`);
  await input.fill(
    "Мне нравится характер Челябинска. Каким будет образование?"
  );
  await run.click();
  await progress.waitFor();
  assert.match(await progress.innerText(), /1 из 3 групп/);
  await emit("result");
  await coverage.waitFor();

  for (const mode of ["error", "truncated", "invalid", "missing"]) {
    await run.click();
    await progress.waitFor();
    assert.equal(
      await coverage.count(),
      0,
      "A new stream clears the previous report"
    );
    await emit(mode);
    await page.getByText("Проверка не выполнена", { exact: true }).waitFor();
    assert.equal(await coverage.count(), 0);
    await run.waitFor({ state: "visible" });
    assert.equal(await run.isEnabled(), true);
  }

  await run.click();
  await progress.waitFor();
  await page.getByRole("button", { name: "Остановить", exact: true }).click();
  assert.equal(
    await input.inputValue(),
    "Мне нравится характер Челябинска. Каким будет образование?"
  );
  assert.ok(
    ((await page.evaluate("window.__factStream098.cancelled")) as number) > 0
  );
  assert.equal(await run.isEnabled(), true);
  assert.equal(await coverage.count(), 0);
  assert.deepEqual(errors, []);
}
