import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import {
  ScanCommand,
  UpdateCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { docClient } from "../lib/db";
import { folderIds } from "../lib/knowledge";
import {
  countKnowledgeCardsByCustomType,
  createCardType,
  createKnowledgeCard,
  deleteCardType,
  deleteKnowledgeCard,
  getCardTypeById,
  updateCardType,
  updateKnowledgeCard,
} from "../lib/models";
import { TableName } from "../lib/schema";
import { requireFixtureDatabase } from "./qa-fixture";

async function typeFixture(context: TestContext) {
  const type = await createCardType({
    id: randomUUID(),
    name: "QA: проверка первой карточки",
    description: "",
    fields: [
      {
        id: "scope",
        name: "Область",
        type: "shortText",
        required: true,
        options: [],
      },
    ],
  });
  const written: string[] = [];
  context.after(async () => {
    for (const id of written) await deleteKnowledgeCard(id);
    await deleteCardType(type.id);
  });
  const input = {
    type: "custom" as const,
    customTypeId: type.id,
    folderId: folderIds.customType(type.id),
    title: "QA: первая карточка",
    owners: ["QA"],
    referenceDescription: "",
    stopFormula: "",
    customFields: { scope: "Синтетическая проверка" },
  };
  return {
    type,
    input,
    create: async () => {
      const card = await createKnowledgeCard(input, { status: "pending" });
      written.push(card.id);
      return card;
    },
  };
}

test("a first custom card invalidates a type edit based on an empty catalog", async (context) => {
  await requireFixtureDatabase();
  const { type, create } = await typeFixture(context);
  assert.equal(await countKnowledgeCardsByCustomType(type.id), 0);
  await create();
  await assert.rejects(
    updateCardType(type.id, { fields: [] }, type.updatedAt),
    { name: "ConditionalCheckFailedException" }
  );
  assert.equal((await getCardTypeById(type.id))?.fields[0]?.id, "scope");
});

test("type deletion loses the race when the first card commits after its Scan", async (context) => {
  await requireFixtureDatabase();
  const { type, create } = await typeFixture(context);
  const send = docClient.send.bind(docClient);
  let injected = false;
  const interception = context.mock.method(
    docClient,
    "send",
    async (command: ScanCommand) => {
      const result = await send(command);
      if (
        !injected &&
        command instanceof ScanCommand &&
        command.input.TableName === TableName.KNOWLEDGE_CARDS
      ) {
        injected = true;
        await create();
      }
      return result;
    }
  );
  try {
    await assert.rejects(deleteCardType(type.id, type.updatedAt), {
      name: "ConditionalCheckFailedException",
    });
  } finally {
    interception.mock.restore();
  }
  assert.equal(injected, true);
  assert.ok(await getCardTypeById(type.id));
  assert.equal(await countKnowledgeCardsByCustomType(type.id), 1);
});

test("custom-card writes guard the exact schema they validated and preserve immutable type membership", async (context) => {
  await requireFixtureDatabase();
  const { type, input, create } = await typeFixture(context);
  const send = docClient.send.bind(docClient);
  let switched = false;
  const interception = context.mock.method(
    docClient,
    "send",
    async (command: TransactWriteCommand) => {
      if (!switched && command instanceof TransactWriteCommand) {
        switched = true;
        await send(
          new UpdateCommand({
            TableName: TableName.KNOWLEDGE_CARD_TYPES,
            Key: { id: type.id },
            UpdateExpression: "SET #fields = :fields, updatedAt = :time",
            ExpressionAttributeNames: { "#fields": "fields" },
            ExpressionAttributeValues: {
              ":fields": [
                {
                  id: "other",
                  name: "Другое поле",
                  type: "shortText",
                  required: true,
                  options: [],
                },
              ],
              ":time": "2026-11-22T12:00:00.000Z",
            },
          })
        );
      }
      return send(command);
    }
  );
  try {
    await assert.rejects(create(), { name: "ConditionalCheckFailedException" });
    assert.equal(
      await countKnowledgeCardsByCustomType(type.id),
      0,
      "The rejected transaction leaves no card"
    );
  } finally {
    interception.mock.restore();
  }
  await assert.rejects(
    create(),
    { name: "ConditionalCheckFailedException" },
    "Obsolete custom field names fail the new schema"
  );
  await updateCardType(type.id, { fields: type.fields });
  const card = await create();
  const epoch = (await getCardTypeById(type.id))?.updatedAt;
  await assert.rejects(
    updateKnowledgeCard(
      card.id,
      { ...input, customTypeId: randomUUID() },
      undefined,
      card.updatedAt
    ),
    { name: "ConditionalCheckFailedException" }
  );
  await deleteKnowledgeCard(card.id);
  assert.notEqual((await getCardTypeById(type.id))?.updatedAt, epoch);
  await deleteCardType(type.id);
  assert.equal(await getCardTypeById(type.id), null);
});
