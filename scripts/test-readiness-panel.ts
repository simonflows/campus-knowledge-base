import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

type Node = { type: string; props: Record<string, unknown> & { children?: unknown } };
type Request = { endpoint: string; method: string; init?: RequestInit };
function harness(response: unknown, options: {
  dirty?: boolean;
  respond?: (request: Request) => Response | Promise<Response>;
} = {}) {
  const code = readFileSync(new URL("../components/editor/editorial-readiness-panel.tsx", import.meta.url), "utf8");
  const mod = { exports: {} as { EditorialReadinessPanel: (props: Record<string, unknown>) => Node } };
  const state: unknown[] = [];
  const effects = new Map<number, { deps: unknown[]; cleanup?: () => void }>();
  let slot = 0;
  const requests: Request[] = [];
  const node = (type: string, props: Node["props"]): Node => ({ type, props });
  runInNewContext(ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    },
  }).outputText, {
    exports: mod.exports,
    require(name: string) {
      if (name === "react/jsx-runtime") return { jsx: node, jsxs: node };
      if (name.endsWith("/button")) return { Button: "button" };
      if (name.endsWith("/textarea")) return { Textarea: "textarea" };
      if (name !== "react") throw Error(name);
      return {
        useState(value: unknown) {
          const id = slot++;
          if (!(id in state)) state[id] = typeof value === "function" ? value() : value;
          return [state[id], (next: unknown) => { state[id] = typeof next === "function" ? next(state[id]) : next; }];
        },
        useRef(value: unknown) {
          const id = slot++;
          if (!(id in state)) state[id] = { current: value };
          return state[id];
        },
        useEffect(effect: () => void | (() => void), deps: unknown[]) {
          const id = slot++;
          const last = effects.get(id);
          if (!last || !last.deps.every((prev, i) => Object.is(prev, deps[i]))) {
            last?.cleanup?.();
            effects.set(id, { deps, cleanup: effect() || undefined });
          }
        },
      };
    },
    AbortController,
    fetch: async (endpoint: string, init?: RequestInit) => {
      const request = { endpoint, method: init?.method ?? "GET", init };
      requests.push(request);
      return options.respond ? options.respond(request) : Response.json(response);
    },
  });
  const refreshes: string[] = [];
  let version = 4;
  const draw = () => {
    slot = 0;
    return mod.exports.EditorialReadinessPanel({
      document: { id: "draft/target", revisionId: `r-${version}`, version,
        content: { sourceCardIds: ["source"], sourceCardTitles: ["Источник"] } }, dirty: options.dirty ?? true,
      onRefreshDraft: async (signal: AbortSignal) => {
        assert.equal(signal.aborted, false);
        refreshes.push("draft/target");
      },
    });
  };
  return { draw, requests, refreshes, setVersion: (next: number) => { version = next; } };
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join(" ");
  return (value as Node | undefined)?.props ? text((value as Node).props.children) : "";
}
function find(value: unknown, predicate: (node: Node) => boolean): Node | undefined {
  if (Array.isArray(value)) return value.map(child => find(child, predicate)).find(Boolean);
  const node = value as Node | undefined;
  if (!node?.props) return;
  if (predicate(node)) return node;
  return find(node.props.children, predicate);
}
const button = (value: unknown, name: RegExp) =>
  find(value, node => node.type === "button" && name.test(text(node)));
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const endpoint = "/api/editor/drafts/draft%2Ftarget/readiness";

function openPanel(ui: ReturnType<typeof harness>) {
  (ui.draw().props.onToggle as (value: unknown) => void)({ currentTarget: { open: true } });
  return ui.draw();
}

function readiness(currentVersionId = "cv-a", version = 4, revisionId = "r-4") {
  return {
    documentId: "draft/target", version, revisionId, revisionNumber: version, ready: false,
    approval: { approvedAt: null }, check: { status: "missing", findings: [] }, disk: { status: "missing" },
    reasons: [], reviewedSourceVersions: [], unknownSources: [], overdueSources: [],
    changedSources: [{ cardId: "source", currentVersionId }],
  };
}

test("a successful response for another revision is a recoverable conflict", async () => {
  for (const [version, revisionId] of [[5, "r-5"], [4, "different"]] as const) {
    const ui = harness({ documentId: "draft/target", version, revisionId });
    assert.match(text(openPanel(ui)), /Загружаем паспорт/);
    await turn();
    const conflict = ui.draw();
    assert.match(text(conflict), /На сервере сохранена другая редакция/);
    assert.doesNotMatch(text(conflict), /Загружаем паспорт/);
    assert.deepEqual(ui.requests.map(({ endpoint }) => endpoint), [endpoint]);
    const reload = button(conflict, /Загрузить актуальный черновик/);
    assert(reload);
    assert.equal(reload.props.disabled, false);
    (reload.props.onClick as () => void)();
    await turn();
    assert.deepEqual(ui.refreshes, ["draft/target"]);
  }
});

test("another document response is unavailable and remains undisclosed", async () => {
  const ui = harness({ documentId: "other private draft", version: 4, revisionId: "r-4", title: "Private title" });
  openPanel(ui);
  await turn();
  assert.match(text(ui.draw()), /Паспорт недоступен/);
  assert.doesNotMatch(text(ui.draw()), /Private title|Загружаем паспорт/);
});

test("check conflict refreshes the passport and offers an explicit draft reload", async () => {
  let readCount = 0;
  const ui = harness(null, { dirty: false, respond: ({ method }) => method === "POST"
    ? Response.json({ error: "Открытая редакция изменилась" }, { status: 409 })
    : Response.json(readCount++ === 0 ? readiness() : readiness("cv-a", 5, "r-5")),
  });
  openPanel(ui);
  await turn();
  const check = button(ui.draw(), /Проверить сохранённую редакцию/);
  assert(check);
  (check.props.onClick as () => void)();
  await turn();

  assert.deepEqual(ui.requests.map(request => [request.method, request.endpoint]), [
    ["GET", endpoint], ["POST", endpoint], ["GET", endpoint],
  ]);
  assert.deepEqual(ui.refreshes, []);
  const conflict = ui.draw();
  assert.match(text(conflict), /На сервере сохранена другая редакция/);
  assert.equal(button(conflict, /Проверить сохранённую редакцию/), undefined);
  const reload = button(conflict, /Загрузить актуальный черновик/);
  assert(reload);
  (reload.props.onClick as () => void)();
  await turn();
  assert.deepEqual(ui.refreshes, ["draft/target"]);
});

test("source conflict refreshes the source link and preserves the entered review comment", async () => {
  let readCount = 0;
  const ui = harness(null, { dirty: false, respond: ({ method }) => method === "POST"
    ? Response.json({ error: "Каноническая версия источника изменилась" }, { status: 409 })
    : Response.json(readiness(readCount++ === 0 ? "cv-a" : "cv-b")),
  });
  openPanel(ui);
  await turn();
  const comment = find(ui.draw(), node => node.type === "textarea");
  assert(comment);
  const entered = "Сверены цифры в источнике";
  (comment.props.onChange as (event: unknown) => void)({ target: { value: entered } });
  const submit = button(ui.draw(), /Проверил по новой версии/);
  assert(submit);
  assert.equal(submit.props.disabled, false);
  (submit.props.onClick as () => void)();
  await turn();

  assert.deepEqual(ui.requests.map(request => request.method), ["GET", "POST", "GET"]);
  const refreshed = ui.draw();
  assert.equal(find(refreshed, node => node.type === "a")?.props.href, "/knowledge?card=source&version=cv-b");
  assert.equal(find(refreshed, node => node.type === "textarea")?.props.value, entered);
  assert.equal(button(refreshed, /Загрузить актуальный черновик/), undefined);
  const retry = button(refreshed, /Проверил по новой версии/);
  assert(retry);
  (retry.props.onClick as () => void)();
  await turn();
  assert.deepEqual(JSON.parse(String(ui.requests[3]?.init?.body)), {
    action: "review-sources", version: 4, revisionId: "r-4",
    sourceVersions: [{ cardId: "source", versionId: "cv-b" }], comment: entered,
  });
});

test("an in-flight conflict refresh cannot replace a newer open revision", async () => {
  let reads = 0;
  const delayed = Promise.withResolvers<Response>();
  const ui = harness(null, { dirty: false, respond: ({ method }) => {
    if (method === "POST") return Response.json({}, { status: 409 });
    reads += 1;
    if (reads === 1) return Response.json(readiness());
    if (reads === 2) return delayed.promise;
    return Response.json(readiness("cv-new-head", 5, "r-5"));
  } });
  openPanel(ui);
  await turn();
  const check = button(ui.draw(), /Проверить сохранённую редакцию/);
  assert(check);
  (check.props.onClick as () => void)();
  await turn();
  const conflictRead = ui.requests[2];
  assert.equal(conflictRead?.method, "GET");
  assert.equal(conflictRead.init?.signal?.aborted, false);
  assert.equal(button(ui.draw(), /Проверить сохранённую редакцию/)?.props.disabled, true);

  ui.setVersion(5);
  ui.draw();
  await turn();
  assert.equal(conflictRead.init?.signal?.aborted, true);
  delayed.resolve(Response.json(readiness("cv-stale")));
  await turn();
  const updated = ui.draw();
  assert.equal(find(updated, node => node.type === "a")?.props.href, "/knowledge?card=source&version=cv-new-head");
  assert.equal(button(updated, /Проверить сохранённую редакцию/)?.props.disabled, false);
});
