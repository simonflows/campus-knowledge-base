import assert from "node:assert/strict";
import { test } from "node:test";

import { handleDemoCollaboration } from "../lib/browser-demo-collaboration";
import {
  createBrowserDemoRequest,
  queueDemoWrite,
  type WorkspaceRequest,
} from "../lib/browser-demo-http";
import { handleDemoKnowledge } from "../lib/browser-demo-knowledge";
import { handleDemoEditor } from "../lib/browser-demo-editor";
import { handleDemoTools } from "../lib/browser-demo-tools";
import { demoHref, readDemoLocation } from "../lib/browser-demo-navigation";
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
import {
  editorialContentSchema,
  type EditorialDocument,
} from "../lib/editorial";
import {
  getParticipantApprovals,
  type CardTypeWithStats,
  type KnowledgeCard,
} from "../lib/knowledge";

function browserProfile() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

test("demo links keep form and search inputs in the browser fragment", () => {
  const href = demoHref("/requests?q=local%20question&card=demo-1");
  assert.equal(href, "#/requests?q=local%20question&card=demo-1");
  const resolved = new URL(href, "https://campus.example/demo");
  assert.equal(resolved.pathname + resolved.search, "/demo");
  assert.deepEqual(readDemoLocation(resolved.hash), {
    pathname: "/requests",
    search: "?q=local%20question&card=demo-1",
    anchor: "",
  });
  assert.equal(demoHref("/api/auth/session"), null);
  assert.equal(demoHref("//third-party.example/q=private"), null);
});

test("demo transport refuses unsupported and authentication requests locally", async () => {
  const storage = browserProfile();
  const request = createBrowserDemoRequest(storage, readBrowserDemo(storage));
  assert.equal(
    (await request("/api/auth/session", { method: "DELETE" })).status,
    404
  );
  assert.equal(
    (await request("https://campus.example/api/search?q=private")).status,
    404
  );
  assert.equal(
    (await request("/api/articles/demo-1/sync", { method: "POST" })).status,
    404
  );
  assert.equal(storage.getItem(BROWSER_DEMO_KEY), null);
});

function postDemoRequest(request: WorkspaceRequest) {
  return request("/api/requests", {
    method: "POST",
    body: JSON.stringify({
      operationId: crypto.randomUUID(),
      recipientUniversityId: "csu",
      subject: "Учебная заявка на сведения",
      question: "Уточните назначение учебной лаборатории.",
    }),
  });
}

function mountDemoRequest(storage: ReturnType<typeof browserProfile>) {
  return createBrowserDemoRequest(storage, readBrowserDemo(storage), [
    handleDemoCollaboration,
  ]);
}

for (const scenario of [
  { name: "role switch", profiles: ["demo-pr-susu"] },
  {
    name: "role switch away and back",
    profiles: ["demo-pr-susu", "demo-pr-midis"],
  },
  { name: "reset to the same role", profiles: [] },
]) {
  test(`a queued request from the old demo workspace is rejected after ${scenario.name}`, async () => {
    const storage = browserProfile();
    const oldWorkspace = mountDemoRequest(storage);
    const hold = Promise.withResolvers<void>();
    const first = queueDemoWrite(storage, () => hold.promise);
    const change = queueDemoWrite(storage, () => {
      if (!scenario.profiles.length) resetBrowserDemo(storage);
      for (const profile of scenario.profiles) {
        writeBrowserDemo(
          storage,
          selectDemoProfile(readBrowserDemo(storage), profile)
        );
      }
    });
    const pending = postDemoRequest(oldWorkspace);
    hold.resolve();
    await Promise.all([first, change]);
    const rejected = await pending;
    assert.equal(rejected.status, 409, await rejected.clone().text());
    assert.deepEqual(readBrowserDemo(storage).requests ?? [], []);
    const live = await postDemoRequest(mountDemoRequest(storage));
    assert.equal(live.status, 201, await live.clone().text());
    assert.equal(
      (await live.json()).authorId,
      readBrowserDemo(storage).profile
    );
  });
}

test("a tab with a stale mounted profile fails closed before its storage event", async () => {
  const storage = browserProfile();
  const oldWorkspace = mountDemoRequest(storage);
  const otherTab = { ...storage };
  writeBrowserDemo(
    otherTab,
    selectDemoProfile(readBrowserDemo(otherTab), "demo-pr-susu")
  );
  const rejected = await postDemoRequest(oldWorkspace);
  assert.equal(rejected.status, 409, await rejected.clone().text());
  assert.deepEqual(readBrowserDemo(storage).requests ?? [], []);
  assert.equal((await oldWorkspace("/api/requests")).status, 409);
});

test("a reset observed during a demo mutation cannot be overwritten by its old save", async () => {
  const storage = browserProfile();
  const otherTab = { ...storage };
  const mounted = readBrowserDemo(storage);
  const request = createBrowserDemoRequest(storage, mounted, [
    (call) =>
      handleDemoCollaboration({
        ...call,
        save(next) {
          resetBrowserDemo(otherTab);
          call.save(next);
        },
      }),
  ]);
  const rejected = await postDemoRequest(request);
  assert.equal(rejected.status, 409);
  assert.notEqual(readBrowserDemo(storage).epoch, mounted.epoch);
  assert.deepEqual(readBrowserDemo(storage).requests ?? [], []);
});

test("an existing v1 store without a session identifier still mounts and saves", async () => {
  const storage = browserProfile();
  storage.setItem(
    BROWSER_DEMO_KEY,
    JSON.stringify({
      version: 1,
      profile: "demo-pr-midis",
      updates: [],
      documents: [],
    })
  );
  const mounted = mountDemoRequest(storage);
  const first = await postDemoRequest(mounted);
  const second = await postDemoRequest(mounted);
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(readBrowserDemo(storage).requests?.length, 2);
});

test("overlapping browser edits see the committed revision and reject a stale save", async () => {
  const storage = browserProfile();
  writeBrowserDemo(
    storage,
    selectDemoProfile(readBrowserDemo(storage), "demo-admin")
  );
  const first = createBrowserDemoRequest(storage, readBrowserDemo(storage), [
    async (call) => {
      if (call.url.pathname !== "/api/knowledge/cards/demo-joint-exercise")
        return;
      const state = call.state;
      const current = getDemoCard(state, "demo-joint-exercise")!;
      if (call.headers.get("If-Match") !== current.updatedAt)
        return Response.json({}, { status: 409 });
      await Promise.resolve();
      const { state: next } = saveDemoCard(
        state,
        { ...current, title: "Первая запись" },
        current
      );
      call.save(next);
      return Response.json({ success: true });
    },
  ]);
  const revision = getDemoCard(
    readBrowserDemo(storage),
    "demo-joint-exercise"
  )!.updatedAt;
  const attempt = () =>
    first("/api/knowledge/cards/demo-joint-exercise", {
      method: "PUT",
      headers: { "If-Match": revision },
    });
  const [saved, rejected] = await Promise.all([attempt(), attempt()]);
  assert.equal(saved.status, 200);
  assert.equal(rejected.status, 409);
  assert.equal(
    getDemoCard(readBrowserDemo(storage), "demo-joint-exercise")?.title,
    "Первая запись"
  );
});

const exerciseId = "demo-joint-exercise";
const newTitle = "Демо: карточка посетителя";

function browserWorkspace() {
  const storage = browserProfile();
  const mount = () =>
    createBrowserDemoRequest(storage, readBrowserDemo(storage), [
      handleDemoKnowledge,
      handleDemoEditor,
      handleDemoTools,
    ]);
  let active = mount();
  const request: WorkspaceRequest = (href, init) => active(href, init);
  return {
    storage,
    request,
    role: (id: string) => {
      writeBrowserDemo(
        storage,
        selectDemoProfile(readBrowserDemo(storage), id)
      );
      active = mount();
    },
    json: (
      href: string,
      method: string,
      data: unknown,
      headers: HeadersInit = {}
    ) => request(href, { method, body: JSON.stringify(data), headers }),
  };
}

test("the ordinary demo moderation contract records both universities and RION before final approval", async () => {
  const { request, role, json } = browserWorkspace();
  const endpoint = `/api/knowledge/cards/${exerciseId}`;
  async function moderate(profile: string, action: string) {
    role(profile);
    const card = (await (await request(endpoint)).json()) as KnowledgeCard;
    return json(
      endpoint + "/moderation",
      "POST",
      { action },
      { "If-Match": card.updatedAt }
    );
  }
  assert.equal((await moderate("demo-admin", "approve")).status, 409);
  const first = await moderate("demo-owner-midis", "confirm-participation");
  assert.equal(first.status, 200);
  assert.deepEqual(getParticipantApprovals(await first.json()), ["midis"]);
  const second = await moderate("demo-owner-susmu", "confirm-participation");
  assert.equal(second.status, 200);
  assert.deepEqual(getParticipantApprovals(await second.json()).sort(), [
    "midis",
    "susmu",
  ]);
  assert.equal((await moderate("demo-admin", "approve")).status, 409);
  assert.equal((await moderate("demo-rio", "confirm-stakeholder")).status, 200);
  const approved = await moderate("demo-admin", "approve");
  assert.equal(approved.status, 200);
  assert.equal((await approved.json()).status, "approved");
  const history = await (await request(endpoint + "/versions")).json();
  assert.match(history.currentVersionId, /^cv-[a-f0-9]{64}$/);
  const snapshot = await (
    await request(endpoint + "/versions/" + history.currentVersionId)
  ).json();
  assert.equal(snapshot.snapshot.id, exerciseId);
});

test("the ordinary demo type constructor persists typed cards and refuses deleting a used type", async () => {
  const { request, role, json } = browserWorkspace();
  role("demo-admin");
  const created = await json("/api/knowledge/card-types", "POST", {
    name: "Учебный тип",
    description: "",
    fields: [{ id: "unit", name: "Отдел", type: "shortText", required: true }],
  });
  assert.equal(created.status, 201);
  const type = (await created.json()) as CardTypeWithStats;
  const bad = await json("/api/knowledge/cards", "POST", {
    type: "custom",
    title: "Учебная карточка",
    owners: ["Учебный координатор"],
    customTypeId: type.id,
    customFields: {},
  });
  assert.equal(bad.status, 400);
  const card = await json("/api/knowledge/cards", "POST", {
    type: "custom",
    title: "Учебная карточка",
    owners: ["Учебный координатор"],
    customTypeId: type.id,
    customFields: { unit: "Отдел обучения" },
  });
  assert.equal(card.status, 201);
  const types = (await (
    await request("/api/knowledge/card-types")
  ).json()) as CardTypeWithStats[];
  assert.equal(types.find(({ id }) => id === type.id)?.cardCount, 1);
  assert.equal(
    (
      await request("/api/knowledge/card-types/" + type.id, {
        method: "DELETE",
      })
    ).status,
    409
  );
});

test("the ordinary demo editor saves revisions, serves a DOCX blob and isolates draft deletion by role", async () => {
  const { storage, request, role, json } = browserWorkspace();
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
  const response = await json("/api/editor/drafts", "POST", { content });
  assert.equal(response.status, 201);
  const document = (await response.json()) as EditorialDocument;
  const endpoint = "/api/editor/drafts/" + document.id;
  const saved = await json(endpoint, "PATCH", {
    action: "save",
    version: document.version,
    content: { ...content, title: newTitle },
  });
  assert.equal(saved.status, 200);
  const latest = await (await request(endpoint)).json();
  assert.equal(latest.document.content.title, newTitle);
  assert.equal(latest.revisions.length, 2);
  const file = await request(
    endpoint + "/docx?revisionId=" + latest.document.revisionId
  );
  assert.equal(file.status, 200);
  assert.match(file.headers.get("Content-Type") ?? "", /wordprocessingml/);
  assert.deepEqual(
    [...new Uint8Array(await file.arrayBuffer()).slice(0, 4)],
    [0x50, 0x4b, 0x03, 0x04]
  );
  role("demo-admin");
  assert.equal(
    (await json(endpoint, "DELETE", { version: latest.document.version }))
      .status,
    404
  );
  role("demo-pr-midis");
  assert.equal(
    (await json(endpoint, "DELETE", { version: document.version })).status,
    409
  );
  assert.equal(
    (await json(endpoint, "DELETE", { version: latest.document.version }))
      .status,
    200
  );
  assert.equal((await request(endpoint)).status, 404);
});

test("submit and approval publish the saved demo revision in the ordinary library", async () => {
  const { storage, request, role, json } = browserWorkspace();
  const card = approvedDemoCards(readBrowserDemo(storage)).find(
    (card) => card.type === "project"
  );
  assert.ok(card);
  const draft = buildDeterministicArticleDraft({
    query: card.title,
    selectedCards: [card],
    matchedArticles: [],
    referenceChunks: [],
  });
  const content = editorialContentSchema.parse({
    ...draft,
    universityId: draft.suggestedUniversityId,
  });
  const created = await json("/api/editor/drafts", "POST", { content });
  const document = (await created.json()) as EditorialDocument;
  const endpoint = `/api/editor/drafts/${document.id}`;
  const submitted = await json(endpoint, "PATCH", {
    action: "submit",
    version: document.version,
    revisionId: document.revisionId,
    reviewerId: "demo-admin",
  });
  assert.equal(submitted.status, 200, await submitted.clone().text());
  const current = (await submitted.json()).document as EditorialDocument;
  role("demo-admin");
  const approved = await json(endpoint, "PATCH", {
    action: "approve",
    version: current.version,
    revisionId: current.revisionId,
  });
  assert.equal(approved.status, 200, await approved.clone().text());
  const library = await request("/api/articles/" + document.id);
  assert.equal(library.status, 200);
  const article = await library.json();
  assert.equal(article.approval.revisionId, current.revisionId);
  const chunk = article.sections[0].chunks[0];
  const basedOnArticle = await json("/api/editor/generate", "POST", {
    query: "",
    basis: {
      articleId: article.id,
      revisionId: article.approval.revisionId,
      chunkIds: [chunk.id],
    },
  });
  assert.equal(basedOnArticle.status, 200, await basedOnArticle.clone().text());
  const result = await basedOnArticle.json();
  assert.equal(result.article.articleBasis[0]?.chunkId, chunk.id);
  assert.match(result.providerMeta.modelLabel, /демо/iu);
});

test("ordinary demo check, analytics and assistant operate on approved browser examples", async () => {
  const { json, request, role } = browserWorkspace();
  const query = "Паспорт кампуса";
  const results = await (
    await request("/api/search?q=" + encodeURIComponent(query))
  ).json();
  assert.ok(
    results.cards.some((card: { href: string }) =>
      card.href.includes("/knowledge")
    )
  );
  const check = await json("/api/fact-check", "POST", {
    text: "В кампусе «Южный Урал» обучается 900000000 студентов.",
    useAi: true,
  });
  assert.equal(check.status, 200);
  assert.ok((await check.json()).summary.yellow > 0);
  const analytics = await json("/api/analytics", "POST", {
    query: "Покажи проекты МИДиС",
    useAi: true,
  });
  const report = await analytics.json();
  assert.ok(report.summary.total > 0);
  assert.equal(report.ai.status, "local");
  const assistant = await json("/api/assistant", "POST", { message: query });
  const answer = await assistant.json();
  assert.equal(answer.status, "local");
  assert.ok(answer.citations.length);
  assert.match(answer.citations[0].href, /^\/knowledge\?card=.*&version=cv-/u);
  role("demo-guest");
  assert.equal((await json("/api/analytics", "POST", { query })).status, 403);
});

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
