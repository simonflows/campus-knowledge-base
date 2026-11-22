import "next/dist/server/node-environment";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  ListTablesCommand,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { NextRequest } from "next/server";
import { strFromU8, unzipSync } from "fflate";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import {
  workAsyncStorage,
  type WorkStore,
} from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { POST as generate } from "../app/api/editor/generate/route";
import { GET as exportDocx } from "../app/api/editor/drafts/[id]/docx/route";
import { flattenArticleChunks, type ReadyArticle } from "../lib/articles";
import { SESSION_COOKIE, signSessionToken } from "../lib/auth-server";
import { docClient, resetDbAvailableCache } from "../lib/db";
import {
  groundGeneratedArticle,
  normalizeGeneratedArticle,
  selectRelevantArticles,
  serializeApprovedChunk,
} from "../lib/editor";
import { editorialContentSchema } from "../lib/editorial";
import {
  createEditorial,
  getEditorial,
  mutateEditorial,
} from "../lib/editorial-models";
import { knowledgeSeedCards } from "../lib/knowledge";
import { TableName } from "../lib/schema";
import { buildArticleMarkdown } from "../lib/yandex-disk";
import { installPilotFixture } from "./pilot-fixture";

const timestamp = "2026-11-22T12:00:00.000Z";
const source = knowledgeSeedCards.find(
  (card) => card.id === "project-susu-digital-twin"
)!;
assert.ok(source);
const publication: ReadyArticle = {
  id: "approved-article-fixture",
  title: "Публикация об утверждённом проекте",
  lead: source.referenceDescription,
  sections: [
    {
      id: "approved-section",
      heading: "Что делает проект",
      level: 2,
      chunks: [{ id: "approved-chunk", content: source.referenceDescription }],
    },
  ],
  sourceCardIds: [source.id],
  sourceCardTitles: [source.title],
  approval: {
    revisionId: "approved-revision",
    approvedAt: timestamp,
    approvedBy: "fixture-admin",
  },
  universityId: "midis",
  projectTitle: source.title,
  topic: "Технологии",
  query: "",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const basis = {
  articleId: publication.id,
  revisionId: "approved-revision",
  chunkIds: ["approved-chunk"],
};
const expected = {
  articleId: publication.id,
  revisionId: basis.revisionId,
  chunkId: basis.chunkIds[0],
  sectionId: publication.sections[0].id,
  articleTitle: publication.title,
  sectionHeading: publication.sections[0].heading,
};

function setup(context: TestContext) {
  const environment = {
    USE_DATABASE: "true",
    DOCUMENT_API_ENDPOINT: "http://fixture.invalid",
    OUTPUT_MODE: "fixture",
    CAMPUS_LOCAL_DEMO: "false",
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, environment);
  resetDbAvailableCache();
  context.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetDbAvailableCache();
  });
  const tables = new Map<string, Map<string, object>>();
  const table = (name?: string) => {
    assert.ok(name);
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  let onArticleScan: (() => void) | undefined;
  let beforeTransaction: (() => void) | undefined;
  context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return {};
    if (command instanceof GetCommand)
      return {
        Item: table(command.input.TableName).get(command.input.Key?.id),
      };
    if (command instanceof ScanCommand) {
      const Items = [...table(command.input.TableName).values()];
      if (command.input.TableName === TableName.ARTICLES) onArticleScan?.();
      return { Items };
    }
    if (command instanceof PutCommand) {
      assert.ok(command.input.Item);
      table(command.input.TableName).set(
        command.input.Item.id,
        command.input.Item
      );
      return {};
    }
    if (command instanceof TransactWriteCommand) {
      const writes = command.input.TransactItems ?? [];
      const keys = writes.map(({ ConditionCheck, Put }) =>
        JSON.stringify([
          ConditionCheck?.TableName ?? Put?.TableName,
          ConditionCheck?.Key?.id ?? Put?.Item?.id,
        ])
      );
      assert.equal(
        new Set(keys).size,
        keys.length,
        "A transaction must operate on each item only once"
      );
      assert.ok(
        writes.length <= 25,
        "A transaction must fit the YDB Document API limit"
      );
      beforeTransaction?.();
      const reasons = writes.map(({ ConditionCheck, Put }) => {
        const guard = ConditionCheck ?? Put;
        const revision = guard?.ExpressionAttributeValues?.[":basisRevision"];
        if (!guard || guard.TableName !== TableName.ARTICLES || !revision)
          return { Code: "None" };
        const id = ConditionCheck?.Key?.id ?? Put?.Item?.id;
        const article = table(TableName.ARTICLES).get(id) as
          | ReadyArticle
          | undefined;
        return {
          Code:
            article?.approval?.revisionId === revision &&
            article?.updatedAt ===
              guard.ExpressionAttributeValues?.[":basisUpdated"]
              ? "None"
              : "ConditionalCheckFailed",
        };
      });
      if (reasons.some(({ Code }) => Code === "ConditionalCheckFailed")) {
        throw new TransactionCanceledException({
          $metadata: {},
          message: "Fixture condition failed",
          CancellationReasons: reasons,
        });
      }
      for (const { Put } of writes) {
        if (Put?.Item) table(Put.TableName).set(Put.Item.id, Put.Item);
      }
      return {};
    }
    assert.fail("Unexpected unmanaged database access");
  });
  context.mock.method(globalThis, "fetch", () =>
    assert.fail("This test must not call a network provider")
  );
  table(TableName.KNOWLEDGE_CARDS).set(source.id, source);
  const kuka = knowledgeSeedCards.find((card) => card.id === "lab-midis-kuka")!;
  assert.ok(kuka);
  table(TableName.KNOWLEDGE_CARDS).set(kuka.id, kuka);
  table(TableName.ARTICLES).set(publication.id, publication);
  const user = installPilotFixture().account("demo-pr-midis");
  const route = "/api/editor/generate";
  function inRequest<T>(request: NextRequest, handler: () => T) {
    const pathname = request.nextUrl.pathname;
    const store = createRequestStoreForAPI(
      request,
      { pathname },
      { tags: [], expirationsByCacheKind: new Map() },
      undefined,
      undefined,
      undefined
    );
    return workAsyncStorage.run({ route: pathname } as WorkStore, () =>
      workUnitAsyncStorage.run(store, handler)
    );
  }
  async function call(input: object) {
    const origin = "http://localhost:8080";
    const request = new NextRequest(origin + route, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: SESSION_COOKIE + "=" + signSessionToken(user.id),
      },
      body: JSON.stringify({
        query: source.title,
        provider: "canonical",
        ...input,
      }),
    });
    return inRequest(request, () => generate(request));
  }
  return {
    user,
    call,
    inRequest,
    articles: table(TableName.ARTICLES),
    onArticleScan: (handler: () => void) => {
      onArticleScan = handler;
    },
    onBeforeTransaction: (handler: () => void) => {
      beforeTransaction = handler;
    },
  };
}

test("an explicit unsupported topic stays unsupported even with an approved basis", async (context) => {
  const { call } = setup(context);
  const query =
    "Напиши статью о роботе FANUC и производстве кислорода на Марсе";
  const response = await call({ basis, query });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.noData, true);
  assert.equal(report.article, undefined);
  assert.deepEqual(report.sourceCardIds, []);
});

test("a verified publication about a different subject cannot override a supported topic", async (context) => {
  const { call } = setup(context);
  const query = "Статья о роботе KUKA";
  const original = await (await call({ query })).json();
  assert.equal(original.noData, false);
  assert.deepEqual(original.article.sourceCardIds, ["lab-midis-kuka"]);
  const mismatch = await call({ basis, query });
  assert.equal(mismatch.status, 422);
  assert.match((await mismatch.json()).error, /выбранный блок/i);
});

test("the university owning the requested article does not become an extra subject constraint", async (context) => {
  const { call, articles } = setup(context);
  const kuka = knowledgeSeedCards.find((card) => card.id === "lab-midis-kuka")!;
  const template = {
    ...publication,
    title: "Проверенная публикация о роботе KUKA",
    sections: publication.sections.map((section) => ({
      ...section,
      chunks: section.chunks.map((chunk) => ({
        ...chunk,
        content: kuka.referenceDescription,
      })),
    })),
    sourceCardIds: [kuka.id],
  };
  const matching = { ...template, id: "article-susmu", universityId: "susmu" };
  articles.set(template.id, template);
  articles.set(matching.id, matching);
  const query =
    "Напиши статью о роботе KUKA в МИДиС с опорой на уже опубликованный материал ЮУГМУ";
  const response = await call({ query });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.noData, false);
  assert.deepEqual(report.article.sourceCardIds, [kuka.id]);
  assert.deepEqual(
    report.usedArticles.map(({ id }: { id: string }) => id),
    [matching.id]
  );
  const explicit = await call({
    query,
    basis: { ...basis, articleId: matching.id },
  });
  assert.equal(explicit.status, 200);
  const selected = await explicit.json();
  assert.deepEqual(selected.article.sourceCardIds, [kuka.id]);
  assert.deepEqual(
    selected.usedArticles.map(({ id }: { id: string }) => id),
    [matching.id]
  );
});

test("a verified basis can supply the subject when the query is blank or generic", async (context) => {
  const { call } = setup(context);
  for (const query of [
    undefined,
    "",
    "Подготовь краткий материал по выбранному блоку.",
  ]) {
    const response = await call({ basis, query });
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.noData, false);
    assert.deepEqual(report.article.articleBasis, [expected]);
    assert.deepEqual(report.article.sourceCardIds, [source.id]);
  }
  assert.equal((await call({ query: undefined })).status, 400);
});

test("Word and Disk markdown include article-basis provenance only in materials that have it", async (context) => {
  const { user, inRequest, articles } = setup(context);
  for (const articleBasis of [undefined, [expected]]) {
    const content = editorialContentSchema.parse({
      ...publication,
      articleBasis,
    });
    const draft = await createEditorial(user, { content, channel: "Оригинал" });
    const article = { ...publication, articleBasis };
    const markdown = buildArticleMarkdown(article);
    const pathname = `/api/editor/drafts/${draft.id}/docx`;
    const request = new NextRequest("http://localhost:8080" + pathname, {
      headers: { cookie: SESSION_COOKIE + "=" + signSessionToken(user.id) },
    });
    const response = await inRequest(request, () =>
      exportDocx(request, {
        params: Promise.resolve({ id: draft.id }),
      })
    );
    assert.equal(response.status, 200);
    const xml = strFromU8(
      unzipSync(new Uint8Array(await response.arrayBuffer()))[
        "word/document.xml"
      ]
    );
    if (!articleBasis) {
      for (const document of [markdown, xml])
        assert.doesNotMatch(document, /Опорные блоки из библиотеки/);
      assert.equal(
        buildArticleMarkdown({ ...article, articleBasis: [] }),
        markdown
      );
      continue;
    }
    for (const document of [markdown, xml]) {
      assert.match(document, /Опорные блоки из библиотеки/);
      for (const field of Object.values(expected))
        assert.ok(document.includes(field));
    }
    articles.delete(publication.id);
    const withdrawn = await inRequest(request, () =>
      exportDocx(request, {
        params: Promise.resolve({ id: draft.id }),
      })
    );
    assert.equal(withdrawn.status, 200);
    const archived = strFromU8(
      unzipSync(new Uint8Array(await withdrawn.arrayBuffer()))[
        "word/document.xml"
      ]
    );
    assert.ok(archived.includes(expected.revisionId));
  }
});

test("generation records the exact approved block and save/readback preserves its historical provenance", async (context) => {
  const { user, call, articles } = setup(context);
  const response = await call({ basis });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.noData, false);
  assert.deepEqual(data.article.articleBasis, [expected]);
  assert.deepEqual(data.usedArticles[0].blocks, [expected]);
  assert.ok(JSON.stringify(data.article.sections).includes("Опорный контекст"));
  const content = editorialContentSchema.parse({
    ...data.article,
    universityId: "midis",
  });
  const draft = await createEditorial(user, { content, channel: "Оригинал" });
  assert.deepEqual((await getEditorial(draft.id, user)).content.articleBasis, [
    expected,
  ]);
  articles.delete(publication.id);
  const saveFromOlderClient = editorialContentSchema.parse({
    ...content,
    title: "Обновлённый черновик",
    articleBasis: undefined,
  });
  const saved = await mutateEditorial(draft.id, user, {
    action: "save",
    version: draft.version,
    content: saveFromOlderClient,
  });
  assert.deepEqual(saved.document.content.articleBasis, [expected]);
  await assert.rejects(
    createEditorial(user, { content, channel: "Оригинал" }),
    { status: 404 }
  );
});

test("wrong revision, forged block, missing revision and draft basis are refused while a request without basis still works", async (context) => {
  const { call, articles } = setup(context);
  assert.equal(
    (await call({ basis: { ...basis, revisionId: "stale-revision" } })).status,
    409
  );
  assert.equal(
    (await call({ basis: { ...basis, chunkIds: ["forged-chunk"] } })).status,
    422
  );
  assert.equal(
    (
      await call({
        basis: { articleId: basis.articleId, chunkIds: basis.chunkIds },
      })
    ).status,
    400
  );
  const legacy = { ...publication, id: "private-draft", approval: undefined };
  articles.set(legacy.id, legacy);
  assert.equal(
    (await call({ basis: { ...basis, articleId: legacy.id } })).status,
    404
  );
  assert.equal(flattenArticleChunks(legacy)[0]?.approvedRevisionId, undefined);
  const unpinned = await call({});
  assert.equal(unpinned.status, 200);
  assert.equal((await unpinned.json()).noData, false);
});

test("a selected publication that changes after the initial read is stale", async (context) => {
  const { call, articles, onArticleScan } = setup(context);
  onArticleScan(() => {
    articles.set(publication.id, {
      ...publication,
      approval: { ...publication.approval, revisionId: "changed-revision" },
    });
  });
  assert.equal((await call({ basis })).status, 409);
});

test("a direct draft write cannot invent provenance fields", async (context) => {
  const { user } = setup(context);
  const content = editorialContentSchema.parse({
    universityId: "midis",
    sourceCardIds: [source.id],
    articleBasis: [{ ...expected, articleTitle: "Подложный заголовок" }],
  });
  await assert.rejects(
    createEditorial(user, { content, channel: "Оригинал" }),
    { status: 422 }
  );
});

test("a publication withdrawn between basis validation and saving cannot become a new draft source", async (context) => {
  const { user, articles, onBeforeTransaction } = setup(context);
  const content = editorialContentSchema.parse({
    universityId: "midis",
    articleBasis: [expected],
  });
  onBeforeTransaction(() => articles.delete(publication.id));
  await assert.rejects(
    createEditorial(user, { content, channel: "Оригинал" }),
    { status: 409 }
  );
});

test("approval refuses a withdrawn basis without deleting it from the historical draft", async (context) => {
  const { user, articles } = setup(context);
  const admin = installPilotFixture().account("demo-admin");
  const content = editorialContentSchema.parse({
    ...publication,
    articleBasis: [expected],
  });
  const draft = await createEditorial(user, { content, channel: "Оригинал" });
  await assert.rejects(
    mutateEditorial(draft.id, user, {
      action: "save",
      version: draft.version,
      content: {
        ...content,
        articleBasis: [{ ...expected, sectionHeading: "Подложная рубрика" }],
      },
    }),
    { status: 422 }
  );
  const submitted = await mutateEditorial(draft.id, user, {
    action: "submit",
    version: draft.version,
    revisionId: draft.revisionId,
    reviewerId: admin.id,
    comment: "",
  });
  articles.delete(publication.id);
  await assert.rejects(
    mutateEditorial(draft.id, admin, {
      action: "approve",
      version: submitted.document.version,
      revisionId: draft.revisionId,
      comment: "",
    }),
    { status: 409 }
  );
  assert.deepEqual((await getEditorial(draft.id, user)).content.articleBasis, [
    expected,
  ]);
  assert.equal(articles.has(draft.id), false);
});

test("approval can atomically replace a publication based on its own previous edition", async (context) => {
  const { user } = setup(context);
  const admin = installPilotFixture().account("demo-admin");
  const content = editorialContentSchema.parse(publication);
  const draft = await createEditorial(user, { content, channel: "Оригинал" });
  const submit = async (document: typeof draft) =>
    mutateEditorial(document.id, user, {
      action: "submit",
      version: document.version,
      revisionId: document.revisionId,
      reviewerId: admin.id,
      comment: "",
    });
  const approve = async (document: typeof draft) =>
    mutateEditorial(document.id, admin, {
      action: "approve",
      version: document.version,
      revisionId: document.revisionId,
      comment: "",
    });
  const first = await approve((await submit(draft)).document);
  const reference = {
    ...expected,
    articleId: draft.id,
    revisionId: draft.revisionId,
  };
  const amended = await mutateEditorial(draft.id, user, {
    action: "save",
    version: first.document.version,
    content: { ...content, articleBasis: [reference] },
  });
  const second = await approve((await submit(amended.document)).document);
  assert.deepEqual(second.publication?.articleBasis, [reference]);
  assert.equal(
    second.publication?.approval?.revisionId,
    amended.document.revisionId
  );
});

test("an explicit university requested for article support selects the actual publication owner", () => {
  const other = {
    ...publication,
    title: "ЮУГМУ — публикация МИДиС",
    universityId: "midis",
  };
  const desired = {
    ...publication,
    id: "susmu-article",
    universityId: "susmu",
  };
  assert.deepEqual(
    selectRelevantArticles(
      [other, desired],
      "Статья с опорой на опубликованный материал ЮУГМУ"
    ).map((article) => article.id),
    [desired.id]
  );
  const chunk = flattenArticleChunks(publication)[0];
  assert.equal(chunk.approvedRevisionId, basis.revisionId);
  const prompt = serializeApprovedChunk(chunk);
  for (const id of [publication.id, basis.revisionId, expected.chunkId])
    assert.ok(prompt.includes(id));
});

test("only repeating a known name as title, lead and body is rejected", () => {
  const candidate = normalizeGeneratedArticle(
    {
      title: source.title,
      lead: source.title,
      sections: [
        {
          heading: "Введение",
          level: 2,
          chunks: [[source.title, source.title, source.title].join("\n\n")],
        },
      ],
      sourceCardIds: [source.id],
    },
    { selectedCards: [source], matchedArticles: [] }
  );
  assert.match(
    groundGeneratedArticle(candidate, [source]) ?? "",
    /лид|блок|повтор/iu
  );
});
