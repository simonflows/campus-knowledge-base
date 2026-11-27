import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { POST as createCard } from "../app/api/knowledge/cards/route";
import { PUT as updateCard } from "../app/api/knowledge/cards/[id]/route";
import { POST as moderateCard } from "../app/api/knowledge/cards/[id]/moderation/route";
import { GET as cardVersion } from "../app/api/knowledge/cards/[id]/versions/[versionId]/route";
import { GET as strategyOptions } from "../app/api/strategy/options/route";
import { SESSION_COOKIE, signSessionToken } from "../lib/auth-server";
import { docClient, resetDbAvailableCache } from "../lib/db";
import {
  knowledgeSeedCards,
  type CustomCard,
  type KnowledgeCard,
  type ProjectCard,
} from "../lib/knowledge";
import {
  getCardVersionId,
  type ApprovedCardVersion,
} from "../lib/knowledge-versions";
import { TableName } from "../lib/schema";
import {
  OFFICIAL_DOCUMENT_TYPE_ID,
  ROADMAP_INDICATOR_TYPE_ID,
  type OfficialDocumentData,
  type StrategyOptions,
} from "../lib/strategy";
import {
  getTrustedIndicatorMeasurement,
  getVersionIndicatorMeasurement,
} from "../lib/strategy-server";

const origin = "https://strategy-fixture.invalid";
const coordinator = "demo-admin";
const owner = "demo-owner-midis";
const ownerGroup = ["Учебный ответственный"];

function request(
  method: string,
  path: string,
  body?: unknown,
  profile = coordinator,
  version?: string
) {
  return new NextRequest(origin + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      origin,
      cookie: `${SESSION_COOKIE}=${signSessionToken(profile)}`,
      ...(version ? { "If-Match": version } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function withRequestContext<T>(input: NextRequest, run: () => T): T {
  const store = createRequestStoreForAPI(
    input,
    input.nextUrl,
    { tags: [], expirationsByCacheKind: new Map() },
    undefined,
    undefined,
    undefined
  );
  return workAsyncStorage.run(
    {} as NonNullable<ReturnType<typeof workAsyncStorage.getStore>>,
    () => workUnitAsyncStorage.run(store, run)
  );
}

async function expectJson<T>(
  response: Promise<Response>,
  expectedStatus: number
): Promise<T> {
  const result = await response;
  const payload = await result.json();
  assert.equal(result.status, expectedStatus, JSON.stringify(payload));
  return payload as T;
}

function create(body: unknown, profile?: string) {
  const input = request("POST", "/api/knowledge/cards", body, profile);
  return withRequestContext(input, () => createCard(input));
}

function update(card: KnowledgeCard, body: unknown, profile?: string) {
  const input = request(
    "PUT",
    `/api/knowledge/cards/${card.id}`,
    body,
    profile,
    card.updatedAt
  );
  return withRequestContext(input, () =>
    updateCard(input, { params: Promise.resolve({ id: card.id }) })
  );
}

function moderate(
  card: KnowledgeCard,
  action: string,
  profile?: string,
  version: string | null = card.updatedAt
) {
  const input = request(
    "POST",
    `/api/knowledge/cards/${card.id}/moderation`,
    { action },
    profile,
    version ?? undefined
  );
  return withRequestContext(input, () =>
    moderateCard(input, { params: Promise.resolve({ id: card.id }) })
  );
}

function options() {
  const input = new NextRequest(origin + "/api/strategy/options");
  return expectJson<StrategyOptions>(strategyOptions(input), 200);
}

function installStorage(context: TestContext, initial: KnowledgeCard[] = []) {
  Object.assign(process.env, {
    CAMPUS_PUBLIC_ORIGIN: origin,
    USE_DATABASE: "true",
    DOCUMENT_API_ENDPOINT: "http://127.0.0.1:1",
    CAMPUS_DEMO_LOGIN: "true",
    CAMPUS_PILOT_ACCOUNTS: "",
    CAMPUS_LOCAL_DEMO: "false",
    OUTPUT_MODE: "",
    SESSION_SECRET: "",
    YANDEX_DISK_OAUTH_TOKEN: "",
  });
  resetDbAvailableCache();
  context.after(resetDbAvailableCache);
  const cards = new Map(initial.map((card) => [card.id, card]));
  const versions = new Map<string, ApprovedCardVersion>();
  const transactions: TransactWriteCommand["input"][] = [];
  let onTransaction: (() => void) | undefined;

  function write(put: PutCommand["input"]) {
    assert.ok(put.Item);
    if (put.TableName === TableName.KNOWLEDGE_CARDS)
      cards.set(put.Item.id, put.Item as KnowledgeCard);
    else if (put.TableName === TableName.KNOWLEDGE_CARD_VERSIONS)
      versions.set(put.Item.id, put.Item as ApprovedCardVersion);
    else assert.fail(`Unexpected fixture write to ${put.TableName}`);
  }

  context.mock.method(globalThis, "fetch", async () =>
    assert.fail("The strategy fixture must not call a remote provider")
  );
  context.mock.method(docClient, "send", async (command: unknown) => {
    if (command instanceof ListTablesCommand) return { TableNames: [] };
    if (command instanceof GetCommand) {
      const { TableName: table, Key: key } = command.input;
      const item =
        table === TableName.KNOWLEDGE_CARDS
          ? cards.get(key?.id)
          : table === TableName.KNOWLEDGE_CARD_VERSIONS
            ? versions.get(key?.id)
            : undefined;
      return { Item: item };
    }
    if (command instanceof ScanCommand)
      return command.input.TableName === TableName.KNOWLEDGE_CARDS
        ? { Items: [...cards.values()] }
        : { Items: [] };
    if (command instanceof UpdateCommand) {
      const current = cards.get(command.input.Key?.id);
      assert.ok(current);
      const updated = {
        ...current,
        diskSync: command.input.ExpressionAttributeValues?.[":diskSync"],
      };
      cards.set(current.id, updated);
      return { Attributes: updated };
    }
    if (command instanceof PutCommand) {
      write(command.input);
      return {};
    }
    assert.ok(command instanceof TransactWriteCommand);
    transactions.push(command.input);
    const callback = onTransaction;
    onTransaction = undefined;
    callback?.();
    for (const item of command.input.TransactItems ?? []) {
      if (!item.ConditionCheck) continue;
      const {
        TableName: table,
        Key: key,
        ExpressionAttributeValues: values,
      } = item.ConditionCheck;
      assert.equal(table, TableName.KNOWLEDGE_CARDS);
      const current = cards.get(key?.id);
      if (!current || current.updatedAt !== values?.[":version"]) {
        throw Object.assign(new Error("Fixture dependency changed"), {
          name: "TransactionCanceledException",
        });
      }
    }
    for (const { Put: put, Update: writeType } of command.input.TransactItems ??
      []) {
      assert.equal(
        writeType,
        undefined,
        "Built-in type definitions have no mutable epoch record"
      );
      if (put) write(put);
    }
    return {};
  });
  return {
    cards,
    versions,
    transactions,
    beforeTransaction: (callback: () => void) => {
      onTransaction = callback;
    },
  };
}

const documentData: OfficialDocumentData = {
  kind: "roadmap",
  sourceOrganization: "Учебная организация",
  url: "https://example.com/qa-roadmap",
  date: "2026-10-12",
  edition: "Учебная редакция",
  directions: [{ id: "work", title: "Учебное направление" }],
  clauses: [
    {
      id: "plan",
      locator: "1",
      excerpt: "Учебный план",
      kind: "plan",
      directionIds: ["work"],
    },
    {
      id: "actual",
      locator: "2",
      excerpt: "Учебный факт",
      kind: "actual",
      directionIds: ["work"],
    },
  ],
};

const officialInput = {
  type: "custom",
  customTypeId: OFFICIAL_DOCUMENT_TYPE_ID,
  title: "Учебный документ",
  owners: ownerGroup,
  officialDocument: documentData,
};

async function publishDocument() {
  const pending = await expectJson<CustomCard>(create(officialInput), 201);
  assert.equal(pending.status, "pending");
  assert.deepEqual((await options()).documents, []);
  return expectJson<CustomCard>(moderate(pending, "approve"), 200);
}

test("план и нулевой факт подтверждаются отдельно, квитанции остаются приватными", async (context) => {
  const storage = installStorage(context);
  const document = await publishDocument();
  const source = { cardId: document.id, versionId: getCardVersionId(document) };
  const indicatorInput = {
    type: "custom",
    customTypeId: ROADMAP_INDICATOR_TYPE_ID,
    title: "Учебный показатель",
    owners: ownerGroup,
    roadmapIndicator: {
      definition: "Количество записей на дату",
      unit: "шт.",
      scope: { kind: "campus" },
      relatedCardIds: [],
      plan: {
        value: 9,
        date: "2026-12-31",
        evidence: { document: source, clauseId: "plan" },
      },
      actual: {
        value: 0,
        date: "2026-09-30",
        evidence: { document: source, clauseId: "actual" },
      },
    },
  };
  const forged = {
    fingerprint: "forged",
    at: "2026-11-27T00:00:00Z",
    actorId: coordinator,
  };
  const pending = await expectJson<CustomCard>(
    create({
      ...indicatorInput,
      indicatorConfirmations: { plan: forged, actual: forged },
    }),
    201
  );
  assert.equal(pending.status, "pending");
  assert.deepEqual(pending.confirmedIndicatorSlots, []);
  assert.equal(
    (storage.cards.get(pending.id) as CustomCard).indicatorConfirmations,
    undefined
  );
  await expectJson(moderate(pending, "approve"), 409);
  await expectJson(moderate(pending, "confirm-plan", owner), 403);
  await expectJson(moderate(pending, "confirm-plan", coordinator, null), 428);
  const planConfirmed = await expectJson<CustomCard>(
    moderate(pending, "confirm-plan"),
    200
  );
  assert.deepEqual(planConfirmed.confirmedIndicatorSlots, ["plan"]);
  assert.equal(planConfirmed.indicatorConfirmations, undefined);
  await expectJson(moderate(pending, "confirm-actual"), 409);
  await expectJson(moderate(planConfirmed, "approve"), 409);

  const confirmed = await expectJson<CustomCard>(
    moderate(planConfirmed, "confirm-actual"),
    200
  );
  assert.deepEqual(confirmed.confirmedIndicatorSlots, ["plan", "actual"]);
  const approved = await expectJson<CustomCard>(
    moderate(confirmed, "approve"),
    200
  );
  assert.equal(approved.status, "approved");
  assert.equal(approved.roadmapIndicator?.actual?.value, 0);
  const raw = storage.cards.get(approved.id)!;
  assert.equal(getTrustedIndicatorMeasurement(raw, "actual")?.value, 0);
  const versionId = getCardVersionId(approved);
  const version = storage.versions.get(versionId)!;
  assert.ok(version.indicatorConfirmations?.actual?.actorId);
  assert.equal(getVersionIndicatorMeasurement(version, "actual")?.value, 0);
  const input = request(
    "GET",
    `/api/knowledge/cards/${approved.id}/versions/${versionId}`
  );
  const presented = await expectJson<ApprovedCardVersion>(
    withRequestContext(input, () =>
      cardVersion(input, {
        params: Promise.resolve({ id: approved.id, versionId }),
      })
    ),
    200
  );
  assert.equal(presented.indicatorConfirmations, undefined);
  assert.equal(
    (presented.snapshot as CustomCard).indicatorConfirmations,
    undefined
  );

  const changed = await expectJson<CustomCard>(
    update(approved, {
      ...indicatorInput,
      roadmapIndicator: {
        ...indicatorInput.roadmapIndicator,
        plan: { ...indicatorInput.roadmapIndicator.plan, value: 11 },
      },
    }),
    200
  );
  assert.equal(changed.status, "pending");
  assert.deepEqual(changed.confirmedIndicatorSlots, ["actual"]);
  assert.equal(
    getTrustedIndicatorMeasurement(storage.cards.get(approved.id)!, "plan")
      ?.value,
    9
  );
  const changedUnit = await expectJson<CustomCard>(
    update(changed, {
      ...indicatorInput,
      roadmapIndicator: { ...indicatorInput.roadmapIndicator, unit: "группы" },
    }),
    200
  );
  assert.deepEqual(changedUnit.confirmedIndicatorSlots, []);
});

test("связь проверяется атомарно, а новая редакция источника делает старую ссылку устаревшей", async (context) => {
  const seed = knowledgeSeedCards.find(
    (card): card is ProjectCard => card.type === "project" && !card.isJoint
  )!;
  const project = {
    ...seed,
    id: "qa-linked-project",
    ownerIds: [],
    status: "approved" as const,
  };
  const storage = installStorage(context, [project]);
  const document = await publishDocument();
  const source = { cardId: document.id, versionId: getCardVersionId(document) };
  const strategyLinks = [
    {
      document: source,
      clauseId: "plan",
      directionId: "work",
      explanation: "Учебная связь",
      evidence: { document: source, clauseId: "plan" },
    },
  ];
  const body = { ...project, strategyLinks };

  storage.beforeTransaction(() => {
    const current = storage.cards.get(document.id)!;
    storage.cards.set(document.id, {
      ...current,
      updatedAt: "2026-12-01T10:00:00.000Z",
    });
  });
  await expectJson(update(project, body), 409);
  assert.equal(storage.cards.get(project.id)?.strategyLinks, undefined);
  const guards =
    storage.transactions
      .at(-1)
      ?.TransactItems?.filter((item) => item.ConditionCheck) ?? [];
  assert.equal(
    guards.length,
    1,
    "The same document needs a single observed-version guard"
  );
  assert.equal(guards[0].ConditionCheck?.Key?.id, document.id);

  const linked = await expectJson<ProjectCard>(update(project, body), 200);
  assert.equal(linked.status, "pending");
  const head = storage.cards.get(document.id)!;
  const draft = await expectJson<CustomCard>(
    update(head, {
      ...officialInput,
      officialDocument: { ...documentData, edition: "Следующая редакция" },
    }),
    200
  );
  assert.equal(draft.status, "pending");
  assert.equal((await options()).documents[0].versionId, source.versionId);
  await expectJson(moderate(draft, "approve"), 200);
  assert.notEqual((await options()).documents[0].versionId, source.versionId);
  await expectJson(moderate(linked, "approve"), 409);
});

test("черновик документа недоступен как опора, показатель с одним планом можно утвердить", async (context) => {
  const storage = installStorage(context);
  const document = await expectJson<CustomCard>(
    create(officialInput, owner),
    201
  );
  const source = { cardId: document.id, versionId: getCardVersionId(document) };
  const input = {
    type: "custom",
    customTypeId: ROADMAP_INDICATOR_TYPE_ID,
    title: "Учебный показатель",
    owners: ownerGroup,
    roadmapIndicator: {
      definition: "Счётчик на конец периода",
      unit: "шт.",
      scope: { kind: "campus" },
      relatedCardIds: [],
      plan: {
        value: 9,
        date: "2026-12-31",
        evidence: { document: source, clauseId: "plan" },
      },
    },
  };
  assert.deepEqual((await options()).documents, []);
  const unavailable = await expectJson<{ error: string }>(
    create(input, owner),
    409
  );
  assert.ok(!unavailable.error.includes(document.title));
  await expectJson(moderate(document, "approve"), 200);
  const draft = await expectJson<CustomCard>(create(input, owner), 201);
  assert.equal(draft.status, "pending");
  const planned = await expectJson<CustomCard>(
    moderate(draft, "confirm-plan"),
    200
  );
  const approved = await expectJson<CustomCard>(
    moderate(planned, "approve"),
    200
  );
  assert.equal(approved.status, "approved");
  assert.equal(approved.roadmapIndicator?.actual, undefined);
  assert.equal(
    getTrustedIndicatorMeasurement(storage.cards.get(approved.id)!, "actual"),
    null
  );
});

test("a valid plan can be confirmed independently while the actual source is stale", async (context) => {
  const storage = installStorage(context);
  const planDoc = await publishDocument();
  const actualPending = await expectJson<CustomCard>(
    create(officialInput),
    201
  );
  const actualDoc = await expectJson<CustomCard>(
    moderate(actualPending, "approve"),
    200
  );
  const pending = await expectJson<CustomCard>(
    create({
      type: "custom",
      customTypeId: ROADMAP_INDICATOR_TYPE_ID,
      title: "Независимые подтверждения",
      owners: ownerGroup,
      roadmapIndicator: {
        definition: "Учебные площадки",
        unit: "шт.",
        scope: { kind: "campus" },
        relatedCardIds: [],
        plan: {
          value: 2,
          date: "2027-12-31",
          evidence: {
            document: {
              cardId: planDoc.id,
              versionId: getCardVersionId(planDoc),
            },
            clauseId: "plan",
          },
        },
        actual: {
          value: 0,
          date: "2026-10-01",
          evidence: {
            document: {
              cardId: actualDoc.id,
              versionId: getCardVersionId(actualDoc),
            },
            clauseId: "actual",
          },
        },
      },
    }),
    201
  );
  storage.cards.set(actualDoc.id, {
    ...storage.cards.get(actualDoc.id)!,
    title: "Следующая редакция фактического документа",
    updatedAt: "2026-12-01T10:00:00Z",
  });
  const confirmed = await expectJson<CustomCard>(
    moderate(pending, "confirm-plan"),
    200
  );
  assert.deepEqual(confirmed.confirmedIndicatorSlots, ["plan"]);
  const checks = storage.transactions
    .at(-1)
    ?.TransactItems?.flatMap((item) =>
      item.ConditionCheck ? [item.ConditionCheck.Key?.id] : []
    );
  assert.deepEqual(checks, [planDoc.id]);
  await expectJson(moderate(confirmed, "confirm-actual"), 409);
  await expectJson(moderate(confirmed, "approve"), 409);
});
