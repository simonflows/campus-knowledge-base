import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "commonjs", source: "", shortCircuit: true };
    return nextLoad(url, context);
  },
});
const editor = import("../components/editor/smart-editor-workspace").finally(() => hooks.deregister());

const draft = {
  status: "draft",
  ownerId: "author",
  reviewerId: "reviewer",
  submittedRevisionId: null,
  revisionId: "current",
} as const;

test("the author's next action follows the text, check and first save", async () => {
  const { editorNextAction } = await editor;
  const guide = { document: null, viewerId: "author", editable: true, dirty: true, conflict: false };
  assert.equal(editorNextAction({ ...guide, missingText: true, checked: false, contradictions: false }), "edit");
  assert.equal(editorNextAction({ ...guide, missingText: false, checked: false, contradictions: false }), "check");
  assert.equal(editorNextAction({ ...guide, missingText: false, checked: true, contradictions: false }), "save");
  assert.equal(editorNextAction({ ...guide, document: draft, missingText: false, checked: true, contradictions: false }), "submit");
});

test("a conflict and contradictions take precedence over sending the draft", async () => {
  const { editorNextAction } = await editor;
  const guide = { document: draft, viewerId: "author", editable: true, dirty: false, missingText: false, checked: true };
  assert.equal(editorNextAction({ ...guide, conflict: true, contradictions: false }), "resolve");
  assert.equal(editorNextAction({ ...guide, conflict: false, contradictions: true }), "check-result");
});

test("only the assigned reviewer gets a decision shortcut on the current submitted version", async () => {
  const { editorNextAction } = await editor;
  const submitted = { ...draft, status: "submitted", submittedRevisionId: "current" } as const;
  const guide = { document: submitted, viewerId: "reviewer", editable: false, dirty: false, conflict: false, missingText: false, checked: false, contradictions: false };
  assert.equal(editorNextAction(guide), "review");
  assert.equal(editorNextAction({ ...guide, viewerId: "author", editable: true }), "waiting");
  assert.equal(editorNextAction({ ...guide, viewerId: "other" }), "history");
  assert.equal(editorNextAction({ ...guide, document: { ...submitted, revisionId: "later" } }), "history");
});
