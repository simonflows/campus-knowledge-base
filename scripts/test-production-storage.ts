import assert from "node:assert/strict";
import { mock } from "node:test";
import { NextRequest } from "next/server";
import { docClient, resetDbAvailableCache } from "../lib/db";
import {
  getAllArticles,
  getAllKnowledgeCards,
  getCardTypeById,
  getAllCardTypes,
  getKnowledgeCardById,
  getArticleById,
} from "../lib/models";
import { POST as factCheck } from "../app/api/fact-check/route";
import { POST as analytics } from "../app/api/analytics/route";
import { GET as articles } from "../app/api/articles/route";
import { GET as article } from "../app/api/articles/[id]/route";
import { TABLE_NAMES, TableName } from "../lib/schema";

const card = {
  type: "university",
  id: "synthetic-passport",
  status: "approved",
  title: "Тестовый паспорт",
  folderId: "01_universities/midis/passport",
  universityId: "midis",
  owners: ["Тестовый владелец"],
  structuredMetrics: [],
  referenceDescription: "Тестовое описание.",
  stopFormula: "Тестовое ограничение.",
};
const manifest = {
  approvedBy: "Тестовый редактор",
  approvedAt: "2026-01-01T00:00:00.000Z",
  cards: [card],
};

function request(path: string, body: unknown) {
  return new NextRequest("http://localhost:8080/api/" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main() {
  Object.assign(process.env, {
    USE_DATABASE: "false",
    OUTPUT_MODE: "",
    CAMPUS_LOCAL_DEMO: "false",
    CAMPUS_DEMO_LOGIN: "false",
    CAMPUS_PILOT_ACCOUNTS: "",
    DOCUMENT_API_ENDPOINT: "http://127.0.0.1:1",
  });
  // Every SDK command is intercepted, including commands from imported routes.
  const transport = mock.method(docClient, "send", async () => {
    throw new Error("Synthetic outage");
  });
  for (const load of [
    getAllKnowledgeCards,
    getAllCardTypes,
    getAllArticles,
    () => getKnowledgeCardById("test"),
    () => getCardTypeById("test"),
    () => getArticleById("test"),
  ]) {
    await assert.rejects(
      load(),
      /баз|хранилищ/i,
      "Production storage loss must reject data reads"
    );
  }
  for (const response of await Promise.all([
    factCheck(
      request("fact-check", {
        text: "Тестовый текст для проверки доступности.",
      })
    ),
    analytics(request("analytics", { query: "Тестовый запрос" })),
    articles(),
    article(new Request("http://localhost:8080"), {
      params: Promise.resolve({ id: "test" }),
    }),
  ])) {
    assert.equal(response.status, 503);
    assert.doesNotMatch(
      JSON.stringify(await response.json()),
      /Synthetic outage|localhost/
    );
  }

  const { GET: ready } = await import("../app/api/ready/route");
  assert.equal((await ready()).status, 503);
  process.env.USE_DATABASE = "true";
  resetDbAvailableCache();
  const probed: string[] = [];
  let unavailable = "";
  transport.mock.mockImplementation(
    async (command: {
      constructor: { name: string };
      input: { TableName: string };
    }) => {
      const name = command.constructor.name;
      if (name === "ListTablesCommand") return { TableNames: TABLE_NAMES };
      if (name === "GetCommand") {
        probed.push(command.input.TableName);
        if (command.input.TableName === unavailable)
          throw new Error("Synthetic outage");
        return {};
      }
      if (name === "ScanCommand") return { Items: [] };
      throw new Error("Unexpected command " + name);
    }
  );
  const healthy = await ready();
  assert.equal(healthy.status, 200);
  assert.match(healthy.headers.get("Cache-Control") || "", /no-store/);
  assert.deepEqual([...new Set(probed)].sort(), [...TABLE_NAMES].sort());
  for (const table of TABLE_NAMES) {
    unavailable = table;
    assert.equal((await ready()).status, 503, table);
  }
  unavailable = "";
  assert.deepEqual(await getAllKnowledgeCards(), []);
  assert.deepEqual(await getAllArticles(), []);
  assert.equal((await articles()).status, 200);

  transport.mock.mockImplementation(async () => {
    throw new Error("Synthetic table read failure");
  });
  assert.equal(
    (
      await factCheck(
        request("fact-check", {
          text: "Тестовый текст при отказе чтения таблицы.",
        })
      )
    ).status,
    503
  );
  assert.equal((await articles()).status, 503);
  assert.equal((await ready()).status, 503);
  process.env.OUTPUT_MODE = "export";
  assert.ok(
    (await getAllKnowledgeCards()).length > 0,
    "Explicit static demo keeps its sample corpus"
  );
  assert.equal(
    (await ready()).status,
    503,
    "Demo data cannot satisfy production readiness"
  );
  process.env.OUTPUT_MODE = "";

  const { importApprovedKnowledge } = await import("../lib/knowledge-import");
  const stored = new Map<string, typeof card & { ownerIds?: string[] }>();
  transport.mock.mockImplementation(
    async (command: {
      constructor: { name: string };
      input: {
        Item: typeof card;
        TableName: string;
        ConditionExpression: string;
      };
    }) => {
      if (
        command.constructor.name === "GetCommand" &&
        command.input.TableName === TableName.KNOWLEDGE_CARD_TYPES
      ) {
        return {
          Item: {
            id: "fixture-type",
            fields: [
              { id: "label", name: "Поле", type: "text", required: true },
            ],
          },
        };
      }
      assert.equal(command.constructor.name, "PutCommand");
      const {
        Item,
        TableName: destination,
        ConditionExpression,
      } = command.input;
      assert.equal(destination, TableName.KNOWLEDGE_CARDS);
      assert.equal(ConditionExpression, "attribute_not_exists(id)");
      if (stored.has(Item.id))
        throw Object.assign(new Error(), {
          name: "ConditionalCheckFailedException",
        });
      stored.set(Item.id, Item);
      return {};
    }
  );
  await importApprovedKnowledge(manifest);
  assert.equal(stored.size, 0);
  for (const bad of [
    { cards: [card] },
    { ...manifest, cards: [card, card] },
    {
      ...manifest,
      cards: [card, { ...card, id: "second", status: "pending" }],
    },
  ]) {
    await assert.rejects(importApprovedKnowledge(bad, true));
    assert.equal(stored.size, 0);
  }
  await assert.rejects(
    importApprovedKnowledge(
      {
        ...manifest,
        cards: [{ ...card, ownerIds: ["nonexistent-fixture-user"] }],
      },
      true
    )
  );
  assert.equal(stored.size, 0);
  assert.equal((await importApprovedKnowledge(manifest, true)).inserted, 1);
  assert.deepEqual(stored.get(card.id)?.ownerIds, []);
  assert.equal(
    (
      await importApprovedKnowledge(
        { ...manifest, cards: [{ ...card, title: "Новая версия" }] },
        true
      )
    ).preserved,
    1
  );
  assert.equal(stored.get(card.id)?.title, card.title);
  const custom = {
    ...card,
    type: "custom",
    id: "fixture-custom",
    customTypeId: "fixture-type",
    folderId: "",
    customFields: { label: "значение" },
  };
  assert.equal(
    (await importApprovedKnowledge({ ...manifest, cards: [custom] }, true))
      .inserted,
    1
  );
  assert.equal(stored.get(custom.id)?.folderId, "03_custom/fixture-type");
  await assert.rejects(
    importApprovedKnowledge({
      ...manifest,
      cards: [{ ...custom, customFields: {} }],
    })
  );
  console.log(
    "PASS production read failures, six-table readiness, approved insert-only import"
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
