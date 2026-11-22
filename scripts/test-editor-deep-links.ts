import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorialLibrary } from "../components/editor/editorial-library";
import type { ReadyArticle } from "../lib/articles";

async function editor() {
  const hooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) return { format: "commonjs", source: "", shortCircuit: true };
      return nextLoad(url, context);
    },
  });
  try {
    return await import("../components/editor/smart-editor-workspace");
  } finally {
    hooks.deregister();
  }
}

test("draft links open only the requested accessible draft after the previous text is saved", async () => {
  const { loadEditorDeepLink } = await editor();
  const events: string[] = [];
  const signal = new AbortController().signal;
  const result = await loadEditorDeepLink({
    id: "right-id", signal,
    read: async (id) => { events.push("read:" + id); return { document: { id } }; },
    flush: async () => { events.push("save"); return true; },
  });
  assert.deepEqual(events, ["read:right-id", "save"]);
  assert.deepEqual(result, { status: "ready", details: { document: { id: "right-id" } } });
});

test("inaccessible, mismatched, unsaved and superseded links cannot replace the open draft", async () => {
  const { loadEditorDeepLink } = await editor();
  const controller = new AbortController();
  const id = "requested";
  const fetchDraft = async () => ({ document: { id } });
  const noSave = async () => { assert.fail("No transition may save after a missing or cancelled load"); };
  assert.deepEqual(await loadEditorDeepLink({
    id, signal: controller.signal, read: async () => { throw Object.assign(new Error("missing"), { status: 404 }); }, flush: noSave,
  }), { status: "unavailable" });
  assert.deepEqual(await loadEditorDeepLink({
    id, signal: controller.signal, read: async () => ({ document: { id: "different" } }), flush: noSave,
  }), { status: "unavailable" });
  assert.deepEqual(await loadEditorDeepLink({
    id, signal: controller.signal, read: fetchDraft, flush: async () => false,
  }), { status: "blocked" });
  assert.deepEqual(await loadEditorDeepLink({
    id, signal: controller.signal, read: async () => { controller.abort(); return fetchDraft(); }, flush: noSave,
  }), { status: "cancelled" });
  const saving = new AbortController();
  assert.deepEqual(await loadEditorDeepLink({
    id, signal: saving.signal, read: fetchDraft, flush: async () => { saving.abort(); return true; },
  }), { status: "cancelled" });
});

const now = "2026-11-22T11:00:00.000Z";
function publication(id: string, title: string): ReadyArticle {
  return {
    id, title, lead: "Текст согласованной публикации.", sections: [], sourceCardIds: [],
    sourceCardTitles: [], universityId: "midis", projectTitle: "", topic: "", query: "",
    createdAt: now, updatedAt: now, approval: { revisionId: "r-" + id, approvedBy: "operator", approvedAt: now },
  };
}

test("library opens the selected approved article and reports missing or private articles", () => {
  const first = publication("first", "Другая статья");
  const selected = publication("second", "Открытая по ссылке статья");
  const legacy = { ...publication("private", "Архивный материал"), approval: undefined };
  const render = (focusedArticleId: string) => renderToStaticMarkup(createElement(EditorialLibrary, {
    articles: [first, selected], legacy: [legacy], busy: false, focusedArticleId,
  }));
  const found = render("second");
  const open = found.match(/<details[^>]+open=""[^>]*>[\s\S]*?<\/details>/g);
  assert.equal(open?.length, 1);
  assert.match(open![0], /Открытая по ссылке статья/);
  assert.doesNotMatch(open![0], /Другая статья/);
  for (const denied of ["unknown", "private"]) {
    const markup = render(denied);
    assert.match(markup, /Публикация недоступна/);
    assert.doesNotMatch(markup, /<details[^>]+open=""/);
  }
});


test("refreshing the open draft sends a read for its exact ID and preserves edits typed while reading", async () => {
  const { refreshOpenEditorDraft } = await editor();
  const document = { id: "target-draft", version: 3 };
  const details = { document: { id: document.id, version: 4 }, text: "Конкурентная редакция" };
  let editorText = "Исходный текст";
  let comparison = "";
  await refreshOpenEditorDraft({
    current: document,
    signal: new AbortController().signal,
    read: async (id) => {
      assert.equal(id, document.id);
      editorText = "Несохранённый ввод";
      return details;
    },
    waitForSave: () => null,
    isStillOpen: () => true,
    hasLocalChanges: () => editorText === "Несохранённый ввод",
    accept: (next, preserveLocalText) => {
      assert.equal(next.document.version, 4);
      if (preserveLocalText) comparison = next.text;
      else editorText = next.text;
    },
  });
  assert.equal(editorText, "Несохранённый ввод");
  assert.equal(comparison, "Конкурентная редакция");
});

test("draft refresh leaves a newer save, another open draft and older responses untouched", async () => {
  const { refreshOpenEditorDraft } = await editor();
  const document = { id: "target-draft", version: 3 };
  const signal = new AbortController().signal;
  const details = { document: { id: document.id, version: 4 } };
  const accept = () => assert.fail("Stale draft response must not be adopted");
  let stillOpen = true;
  let saves = 0;
  await refreshOpenEditorDraft({
    current: document, signal, read: async () => details,
    waitForSave: () => ++saves === 2 ? Promise.resolve().then(() => { stillOpen = false; }) : null,
    isStillOpen: () => stillOpen, hasLocalChanges: () => false, accept,
  });
  assert.equal(saves, 2);
  stillOpen = true;
  await refreshOpenEditorDraft({
    current: document, signal, read: async () => { stillOpen = false; return details; },
    waitForSave: () => null,
    isStillOpen: () => stillOpen, hasLocalChanges: () => false, accept,
  });
  for (const received of [{ id: "other", version: 8 }, { id: document.id, version: 2 }]) {
    await assert.rejects(refreshOpenEditorDraft({
      current: document, signal, read: async () => ({ document: received }),
      waitForSave: () => null, isStillOpen: () => true, hasLocalChanges: () => false, accept,
    }), /актуальный черновик/);
  }
});
