import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BROWSER_DEMO_KEY,
  approvedDemoCards,
  demoArticles,
  getDemoCard,
  moderateDemoCard,
  moderateDemoDocument,
  readBrowserDemo,
  resetBrowserDemo,
  saveDemoCard,
  saveDemoDocument,
  selectDemoProfile,
  visibleDemoCards,
  visibleDemoDocuments,
  writeBrowserDemo,
} from "../lib/browser-demo";
import { buildDeterministicArticleDraft } from "../lib/editor";
import { editorialContentSchema } from "../lib/editorial";

function browserProfile() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const exerciseId = "demo-joint-exercise";
const newTitle = "Демо: карточка посетителя";

test("edits survive reload in one browser profile and reset restores the exercise", () => {
  const first = browserProfile();
  const second = browserProfile();
  const initial = selectDemoProfile(readBrowserDemo(first), "demo-admin");
  const exercise = getDemoCard(initial, exerciseId);
  assert.ok(exercise);
  const { state } = saveDemoCard(
    initial,
    { ...exercise, title: newTitle },
    exercise
  );
  writeBrowserDemo(first, state);

  assert.equal(
    getDemoCard(readBrowserDemo(first), exerciseId)?.title,
    newTitle
  );
  assert.equal(
    getDemoCard(readBrowserDemo(second), exerciseId)?.title,
    exercise.title
  );
  resetBrowserDemo(first);
  assert.equal(
    getDemoCard(readBrowserDemo(first), exerciseId)?.title,
    exercise.title
  );
});

test("invalid storage stays intact until explicit reset and failed writes are surfaced", () => {
  const storage = browserProfile();
  storage.setItem(
    BROWSER_DEMO_KEY,
    '{"version":1,"updates":[{"id":"broken"}]}'
  );
  assert.throws(() => readBrowserDemo(storage), /повреждено/);
  assert.match(storage.getItem(BROWSER_DEMO_KEY) ?? "", /broken/);
  assert.throws(
    () =>
      resetBrowserDemo({
        ...storage,
        setItem: () => {
          throw new Error("QuotaExceededError");
        },
      }),
    /Не удалось сохранить/
  );
  assert.match(storage.getItem(BROWSER_DEMO_KEY) ?? "", /broken/);
  assert.doesNotThrow(() => resetBrowserDemo(storage));
});

test("only participant owners confirm and the coordinator approves the joint exercise", () => {
  const initial = readBrowserDemo(browserProfile());
  assert.equal(
    approvedDemoCards(initial).some((card) => card.id === exerciseId),
    false
  );
  assert.throws(
    () => moderateDemoCard(initial, exerciseId, "confirm"),
    /владелец/
  );

  const coordinator = selectDemoProfile(initial, "demo-admin");
  assert.throws(
    () => moderateDemoCard(coordinator, exerciseId, "approve"),
    /участников/
  );
  const firstOwner = selectDemoProfile(initial, "demo-owner-midis");
  const confirmedOnce = moderateDemoCard(firstOwner, exerciseId, "confirm");
  assert.throws(
    () => moderateDemoCard(confirmedOnce, exerciseId, "confirm"),
    /подтвердил/
  );
  const secondOwner = selectDemoProfile(confirmedOnce, "demo-owner-susmu");
  const confirmedTwice = moderateDemoCard(secondOwner, exerciseId, "confirm");
  const approved = moderateDemoCard(
    selectDemoProfile(confirmedTwice, "demo-admin"),
    exerciseId,
    "approve"
  );
  assert.equal(
    approvedDemoCards(approved).filter((card) => card.id === exerciseId).length,
    1
  );

  const guest = selectDemoProfile(initial, "demo-guest");
  assert.equal(
    visibleDemoCards(guest).some((card) => card.id === exerciseId),
    false
  );
  assert.equal(
    visibleDemoCards(selectDemoProfile(approved, "demo-guest")).some(
      (card) => card.id === exerciseId
    ),
    true
  );
});

test("approved demo evidence stays available while its revision awaits approval", () => {
  const storage = browserProfile();
  const state = readBrowserDemo(storage);
  const published = approvedDemoCards(state).find(
    (card) => card.type === "project"
  );
  assert.ok(published?.type === "project");
  assert.throws(
    () => saveDemoCard(state, { ...published, title: newTitle }, published),
    /недоступно/
  );

  const coordinator = selectDemoProfile(state, "demo-admin");
  const edited = saveDemoCard(
    coordinator,
    { ...published, title: newTitle },
    published
  );
  writeBrowserDemo(storage, edited.state);
  const loaded = readBrowserDemo(storage);
  assert.equal(getDemoCard(loaded, published.id)?.title, newTitle);
  assert.equal(
    approvedDemoCards(loaded).find((card) => card.id === published.id)?.title,
    published.title
  );
  assert.throws(
    () => saveDemoCard(loaded, published, published),
    /другой вкладке/
  );
});

test("the PR role can create and edit its own in-scope demo draft", () => {
  const state = readBrowserDemo(browserProfile());
  const exercise = getDemoCard(state, exerciseId);
  assert.ok(exercise?.type === "project");
  const next = saveDemoCard(state, { ...exercise, title: newTitle }, exercise);
  assert.equal(next.card.title, newTitle);
  const created = saveDemoCard(next.state, {
    ...exercise,
    title: "Новый учебный проект",
  });
  assert.notEqual(created.card.id, exerciseId);
  assert.equal(created.card.status, "pending");
  assert.deepEqual(created.card.ownerIds, [
    "demo-owner-midis",
    "demo-owner-susmu",
  ]);
});

test("editor drafts remain private until submission and approved material survives reload", () => {
  const storage = browserProfile();
  const state = readBrowserDemo(storage);
  const source = approvedDemoCards(state).find(
    (card) => card.type === "project"
  );
  assert.ok(source);
  const draft = buildDeterministicArticleDraft({
    query: source.title,
    selectedCards: [source],
    matchedArticles: [],
    referenceChunks: [],
  });
  const content = editorialContentSchema.parse({
    ...draft,
    universityId: draft.suggestedUniversityId,
  });
  const saved = saveDemoDocument(state, content, null);
  const coordinator = selectDemoProfile(saved.state, "demo-admin");
  assert.equal(visibleDemoDocuments(coordinator).length, 0);
  assert.throws(
    () => moderateDemoDocument(coordinator, saved.document.id, "approve"),
    /координатора/
  );
  assert.equal(
    visibleDemoDocuments(selectDemoProfile(saved.state, "demo-pr-susu")).length,
    0
  );

  const submitted = moderateDemoDocument(
    saved.state,
    saved.document.id,
    "submit"
  );
  const reviewing = selectDemoProfile(submitted, "demo-admin");
  assert.equal(visibleDemoDocuments(reviewing)[0]?.id, saved.document.id);
  writeBrowserDemo(
    storage,
    moderateDemoDocument(reviewing, saved.document.id, "approve")
  );
  const published = demoArticles(readBrowserDemo(storage)).find(
    (article) => article.id === saved.document.id
  );
  assert.equal(published?.title, content.title);
  assert.ok(published?.approval);
});
