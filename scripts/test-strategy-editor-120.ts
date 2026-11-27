import { randomUUID } from "node:crypto";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import {
  captureDatabase,
  restoreDatabase,
  verifyDatabaseArchive,
} from "../lib/database-backup";
import { TableName } from "../lib/schema";
import { getCardVersionId } from "../lib/knowledge-versions";
import assert from "node:assert/strict";
import type { APIRequestContext } from "playwright-core";
import type { KnowledgeCard } from "../lib/knowledge";
import type { EditorialDocument } from "../lib/editorial";
import type { EditorialReadiness } from "../lib/editorial-readiness";
import type { StrategyOptions } from "../lib/strategy";
import type { StrategyAnalyticsReport } from "../lib/strategy-analytics";

export async function runStrategyEditorChecks(
  author: APIRequestContext,
  coordinator: APIRequestContext,
  base: string,
  ids: { documentId: string; indicatorId: string }
) {
  const rows = (await (
    await coordinator.get(base + "/api/knowledge/cards")
  ).json()) as KnowledgeCard[];
  const indicator = rows.find((card) => card.id === ids.indicatorId)!;
  const document = rows.find((card) => card.id === ids.documentId)!;
  const headers = { Origin: base };
  const generated = await author.post(base + "/api/editor/generate", {
    headers,
    data: {
      provider: "canonical",
      query: `Подготовь справку о показателе «${indicator.title}»`,
    },
  });
  assert.equal(generated.status(), 200, await generated.text());
  const generatedBody = await generated.json();
  assert.equal(generatedBody.noData, false);
  assert.deepEqual(generatedBody.article.sourceCardIds, [ids.indicatorId]);
  assert.match(JSON.stringify(generatedBody.article), /план к 2027-08-01/u);
  assert.match(
    JSON.stringify(generatedBody.article),
    /0 шт.; факт по состоянию на 2026-11-25/u
  );
  const created = await author.post(base + "/api/editor/drafts", {
    headers,
    data: { content: { ...generatedBody.article, universityId: "midis" } },
  });
  assert.equal(created.status(), 201, await created.text());
  const draft = (await created.json()) as EditorialDocument;
  const path = base + "/api/editor/drafts/" + draft.id;
  const details = await (await author.get(path)).json();
  const reviewer = details.reviewers.find(
    (row: { id: string; role: string }) => row.role === "admin"
  );
  assert.ok(reviewer);
  const submitted = await author.patch(path, {
    headers,
    data: {
      action: "submit",
      version: draft.version,
      revisionId: draft.revisionId,
      reviewerId: reviewer.id,
    },
  });
  assert.equal(submitted.status(), 200, await submitted.text());
  const sent = (await submitted.json()).document as EditorialDocument;
  const approved = await coordinator.patch(path, {
    headers,
    data: {
      action: "approve",
      version: sent.version,
      revisionId: sent.revisionId,
    },
  });
  assert.equal(approved.status(), 200, await approved.text());
  const accepted = (await approved.json()).document as EditorialDocument;
  const checked = await author.post(path + "/readiness", {
    headers,
    data: {
      action: "check",
      version: accepted.version,
      revisionId: accepted.revisionId,
    },
  });
  assert.equal(checked.status(), 200, await checked.text());
  assert.equal(
    ((await checked.json()) as EditorialReadiness).check.status,
    "passed"
  );
  // A new draft keeps the old public source. Only a new approval invalidates dependent evidence.
  assert.ok(document.type === "custom" && document.officialDocument);
  const changed = await coordinator.put(
    base + "/api/knowledge/cards/" + document.id,
    {
      headers: { ...headers, "If-Match": document.updatedAt },
      data: {
        ...document,
        officialDocument: { ...document.officialDocument, edition: "QA 2" },
      },
    }
  );
  assert.equal(changed.status(), 200, await changed.text());
  const pending = (await changed.json()) as KnowledgeCard;
  const stillCurrent = await author.get(path + "/readiness");
  assert.equal(
    ((await stillCurrent.json()) as EditorialReadiness).unknownSources.length,
    0
  );
  const published = await coordinator.post(
    base + `/api/knowledge/cards/${document.id}/moderation`,
    {
      headers: { ...headers, "If-Match": pending.updatedAt },
      data: { action: "approve" },
    }
  );
  assert.equal(published.status(), 200, await published.text());
  const stale = await author.get(path + "/readiness");
  const readiness = (await stale.json()) as EditorialReadiness;
  assert.equal(readiness.ready, false);
  assert.ok(readiness.unknownSources.includes(ids.indicatorId));
  const options = (await (
    await coordinator.get(base + "/api/strategy/options")
  ).json()) as StrategyOptions;
  const current = options.documents.find((doc) => doc.cardId === document.id)!;
  const report = await coordinator.post(base + "/api/analytics", {
    headers,
    data: {
      mode: "strategy",
      documentId: current.cardId,
      documentVersionId: current.versionId,
    },
  });
  assert.equal(report.status(), 200);
  const staleIndicator = (
    (await report.json()) as StrategyAnalyticsReport
  ).indicators.find((row) => row.card.cardId === indicator.id)!;
  assert.equal(staleIndicator.actual.status, "stale");
  assert.equal("value" in staleIndicator.actual, false);
  const staleGeneration = await author.post(base + "/api/editor/generate", {
    headers,
    data: {
      provider: "canonical",
      query: `Подготовь справку о показателе «${indicator.title}»`,
    },
  });
  assert.equal(staleGeneration.status(), 409);
  assert.match((await staleGeneration.json()).error, /Документ-основание/u);
  const endpoint = "http://127.0.0.1:8000";
  const client = new DynamoDBClient({
    endpoint,
    region: process.env.DOCUMENT_API_REGION ?? "us-east-1",
    maxAttempts: 1,
    credentials: {
      accessKeyId: "campusLocalTest",
      secretAccessKey: "localTestOnly",
    },
  });
  try {
    const archive = verifyDatabaseArchive(
      await captureDatabase({ client, endpoint })
    );
    assert.equal(archive.tables.length, 11);
    const prefix = `qa095-strategy120-${randomUUID()}-`;
    const restored = await restoreDatabase({
      client,
      endpoint,
      target: { prefix },
      archive,
    });
    assert.equal(restored.sha256, archive.sha256);
    for (const [table, id] of [
      [TableName.KNOWLEDGE_CARDS, indicator.id],
      [TableName.KNOWLEDGE_CARD_VERSIONS, getCardVersionId(indicator)],
    ] as const) {
      const before = await client.send(
        new GetItemCommand({
          TableName: table,
          Key: { id: { S: id } },
          ConsistentRead: true,
        })
      );
      const after = await client.send(
        new GetItemCommand({
          TableName: prefix + table,
          Key: { id: { S: id } },
          ConsistentRead: true,
        })
      );
      assert.ok(before.Item?.indicatorConfirmations);
      assert.deepEqual(after.Item, before.Item);
    }
    console.log(
      "PASS strategy backup: actual isolated restore of 11 tables preserves structured values and private confirmations in current and historical indicator rows"
    );
  } finally {
    client.destroy();
  }
  console.log(
    "PASS strategy editor HTTP: explicit indicator, generated plan/zero actual, save/submit/approve/check, old snapshot, changed dependency and hidden stale numbers"
  );
}
