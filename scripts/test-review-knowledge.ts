import "next/dist/server/node-environment-baseline";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { NextRequest } from "next/server";
import { createRequestStoreForAPI } from "next/dist/server/async-storage/request-store";
import { createWorkStore } from "next/dist/server/async-storage/work-store";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external";
import { POST as syncArticle } from "../app/api/articles/[id]/sync/route";
import {
  POST as createEditRequest,
  PATCH as updateEditRequest,
} from "../app/api/knowledge/cards/[id]/edit-requests/route";
import { POST as moderate } from "../app/api/knowledge/cards/[id]/moderation/route";
import { POST as syncCard } from "../app/api/knowledge/cards/[id]/sync/route";
import { PATCH as patchCardType } from "../app/api/knowledge/card-types/[id]/route";
import { SESSION_COOKIE, signSessionToken } from "../lib/auth-server";
import { docClient, resetDbAvailableCache } from "../lib/db";
import { importApprovedKnowledge } from "../lib/knowledge-import";
import {
  knowledgeSeedCards,
  type CardTypeDefinition,
  type ProjectCard,
} from "../lib/knowledge";
import { getAllCardTypes } from "../lib/models";
import { TableName } from "../lib/schema";
import { buildCustomFieldValuesSchema } from "../lib/validation/knowledge";

const version = "2026-10-01T00:00:00.001Z";
const cardType: CardTypeDefinition = {
  id: "first-type",
  name: "Проверка типа",
  description: "",
  fields: [
    {
      id: "note",
      name: "Примечание",
      type: "shortText",
      required: true,
      options: [],
    },
  ],
  createdAt: version,
  updatedAt: version,
};

function useDynamo(context: TestContext, send: (command: unknown) => unknown) {
  Object.assign(process.env, {
    DOCUMENT_API_ENDPOINT: "http://127.0.0.1:1",
    USE_DATABASE: "true",
    OUTPUT_MODE: "",
    CAMPUS_LOCAL_DEMO: "false",
    CAMPUS_DEMO_LOGIN: "true",
    CAMPUS_PILOT_ACCOUNTS: "",
    ADMIN_ACCESS_PIN: "",
    SESSION_SECRET: "",
  });
  resetDbAvailableCache();
  context.after(resetDbAvailableCache);
  context.mock.method(docClient, "send", async (command: unknown) =>
    command instanceof ListTablesCommand ? { TableNames: [] } : send(command)
  );
}

function withAdmin<T>(
  path: string,
  handler: (
    request: NextRequest,
    context: { params: Promise<{ id: string }> }
  ) => T,
  id: string,
  {
    method = "POST",
    body = {},
    expected,
    profile = "demo-admin",
  }: { method?: string; body?: unknown; expected?: string; profile?: string } = {}
): T {
  const headers = new Headers({ "Content-Type": "application/json" });
  const token = signSessionToken(profile);
  headers.set("Cookie", `${SESSION_COOKIE}=${token}`);
  if (expected !== undefined) headers.set("If-Match", expected);
  const request = new NextRequest("http://localhost:8080" + path, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  const requestStore = createRequestStoreForAPI(
    request,
    { pathname: path },
    { tags: [], expirationsByCacheKind: new Map() },
    undefined,
    undefined,
    undefined
  );
  const workStore = createWorkStore({
    page: `${path}/route`,
    deploymentId: "",
    buildId: "fixture",
    previouslyRevalidatedTags: [],
    renderOpts: {
      assetPrefix: "",
      cacheComponents: false,
      cacheLifeProfiles: { default: { stale: 0, revalidate: 1, expire: 2 } },
      isBuildTimePrerendering: false,
      isDraftMode: false,
      isDebugDynamicAccesses: false,
      staticPageGenerationTimeout: 1,
      validationLevel: "warning",
      waitUntil: undefined,
      onClose() {},
      onAfterTaskError: undefined,
      experimental: {
        isRoutePPREnabled: false,
        authInterrupts: false,
        useCacheTimeout: 1,
        durableUseCacheEntries: false,
      },
    },
  });
  return workAsyncStorage.run(workStore, () =>
    workUnitAsyncStorage.run(requestStore, () =>
      handler(request, { params: Promise.resolve({ id }) })
    )
  );
}

test("A required custom field rejects whitespace-only values", () => {
  assert.equal(
    buildCustomFieldValuesSchema(cardType).safeParse({ note: "  \t " }).success,
    false
  );
});

test("Custom fields return normalized values and reject impossible calendar dates", () => {
  const definition: CardTypeDefinition = {
    ...cardType,
    fields: [
      ...cardType.fields,
      { id: "date", name: "Дата", type: "date", required: false, options: [] },
      {
        id: "directions",
        name: "Направления",
        type: "list",
        required: false,
        options: [],
      },
    ],
  };
  const schema = buildCustomFieldValuesSchema(definition);
  assert.deepEqual(
    schema.parse({
      note: "  проверено  ",
      date: " 2024-02-29 ",
      directions: [" тест "],
    }),
    {
      note: "проверено",
      date: "2024-02-29",
      directions: ["тест"],
    }
  );
  assert.equal(
    schema.safeParse({ note: "Проверено", date: "2026-02-29" }).success,
    false
  );
  assert.deepEqual(schema.parse({ note: "Проверено", date: null }), {
    note: "Проверено",
    date: null,
  });
});

test("Approved imports reject project participants missing from the campus directory", async () => {
  const joint = knowledgeSeedCards.find(
    (card): card is ProjectCard => card.type === "project" && card.isJoint
  )!;
  const manifest = {
    approvedBy: "Проверяющий",
    approvedAt: version,
    cards: [
      {
        ...joint,
        status: "approved",
        ownerIds: [],
        participantApprovals: joint.participantUniversityIds,
      },
    ],
  };
  assert.equal((await importApprovedKnowledge(manifest)).validated, 1);
  const unknown = [...joint.participantUniversityIds, "unknown-university"];
  await assert.rejects(
    importApprovedKnowledge({
      ...manifest,
      cards: [
        {
          ...manifest.cards[0],
          participantUniversityIds: unknown,
          participantApprovals: unknown,
        },
      ],
    })
  );
});

test("The type catalog includes definitions from subsequent DynamoDB pages", async (context) => {
  const second = { ...cardType, id: "second-type" };
  useDynamo(context, (command) => {
    assert.ok(command instanceof ScanCommand);
    assert.equal(command.input.TableName, TableName.KNOWLEDGE_CARD_TYPES);
    if (command.input.ExclusiveStartKey === undefined) {
      return { Items: [cardType], LastEvaluatedKey: { id: cardType.id } };
    }
    assert.deepEqual(command.input.ExclusiveStartKey, { id: cardType.id });
    return { Items: [second] };
  });
  assert.deepEqual(
    (await getAllCardTypes()).map(({ id }) => id),
    [cardType.id, second.id]
  );
});

test("A decision for an older card version is refused without changing the latest draft", async (context) => {
  const card = {
    ...knowledgeSeedCards[0],
    status: "pending",
    updatedAt: version,
  };
  let saved = card;
  useDynamo(context, (command) => {
    if (command instanceof GetCommand) return { Item: saved };
    assert.ok(command instanceof PutCommand);
    saved = command.input.Item as typeof card;
    return {};
  });
  const route = `/api/knowledge/cards/${card.id}/moderation`;
  const stale = await withAdmin(route, moderate, card.id, {
    body: { action: "reject" },
    expected: card.createdAt,
  });
  assert.equal(stale.status, 409);
  assert.equal(saved.status, "pending");
  const fresh = await withAdmin(route, moderate, card.id, {
    body: { action: "reject" },
    expected: version,
  });
  assert.equal(fresh.status, 200);
  assert.equal(saved.status, "rejected");
  saved = card;
  const legacy = await withAdmin(route, moderate, card.id, {
    body: { action: "reject" },
  });
  assert.equal(legacy.status, 200);
});

test("A stale participation decision returns a version conflict before checking completed participation", async (context) => {
  const card: ProjectCard = {
    ...knowledgeSeedCards.find((card): card is ProjectCard => card.type === "project")!,
    id: "fixture-joint", status: "pending", isJoint: true,
    initiatorUniversityId: "midis", participantUniversityIds: ["midis", "susu"],
    requiredApprovalUniversityIds: ["midis", "susu"], participantApprovals: ["midis"],
    submittedBy: "fixture-coordinator", ownerIds: [], updatedAt: version,
  };
  useDynamo(context, (command) => {
    assert.ok(command instanceof GetCommand, "A stale decision must not write");
    return { Item: card };
  });
  const path = `/api/knowledge/cards/${card.id}/moderation`;
  const stale = await withAdmin(path, moderate, card.id, {
    profile: "demo-owner-midis", body: { action: "confirm-participation" }, expected: "older-version",
  });
  assert.equal(stale.status, 409);
  for (const options of [
    { profile: "demo-owner-midis", expected: version },
    { profile: "demo-owner-midis" },
    { profile: "demo-owner-csu", expected: "older-version" },
  ]) {
    const response = await withAdmin(path, moderate, card.id, {
      ...options, body: { action: "confirm-participation" },
    });
    assert.equal(response.status, 403);
  }
});

test("A card-type edit cannot recreate a type deleted during the edit", async (context) => {
  let stored: CardTypeDefinition | undefined = cardType;
  useDynamo(context, (command) => {
    if (command instanceof GetCommand) return { Item: stored };
    if (command instanceof ScanCommand) return { Items: [] };
    assert.ok(command instanceof PutCommand);
    stored = undefined;
    if (command.input.ConditionExpression?.includes("attribute_exists(id)")) {
      throw Object.assign(new Error("Fixture type disappeared"), {
        name: "ConditionalCheckFailedException",
      });
    }
    stored = command.input.Item as CardTypeDefinition;
    return {};
  });
  const response = await withAdmin(
    `/api/knowledge/card-types/${cardType.id}`,
    patchCardType,
    cardType.id,
    {
      method: "PATCH",
      body: { description: "Новое описание" },
    }
  );
  assert.equal(response.status, 409);
  assert.equal(stored, undefined);
});

for (const [route, method, handler] of [
  ["knowledge/cards/fixture/edit-requests", "POST", createEditRequest],
  ["knowledge/cards/fixture/edit-requests", "PATCH", updateEditRequest],
  ["knowledge/cards/fixture/sync", "POST", syncCard],
  ["articles/fixture/sync", "POST", syncArticle],
] as const) {
  test(`${method} ${route} reports loss of table reads after a healthy database probe`, async (context) => {
    useDynamo(context, (command) => {
      assert.ok(command instanceof GetCommand);
      throw new Error("Fixture table read failure");
    });
    const response = await withAdmin(`/api/${route}`, handler, "fixture", {
      method,
    });
    assert.equal(response.status, 503);
    assert.doesNotMatch(
      JSON.stringify(await response.json()),
      /Fixture table read failure/
    );
  });
}
