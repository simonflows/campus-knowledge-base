import assert from "node:assert/strict";
import { checkDiskSync } from "./check-disk-sync";
import { TableName } from "../lib/schema";

async function main() {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const version = "2026-11-20T16:00:00Z";
  const success = {
    updatedAt: version,
    diskSync: {
      status: "synced",
      sourceUpdatedAt: version,
      lastSyncedAt: version,
    },
  };
  let pages = 0;
  const report = await checkDiskSync(async (input) => {
    pages++;
    assert.ok(
      input.ProjectionExpression &&
        !/title|content|filePath|message/.test(input.ProjectionExpression)
    );
    if (input.TableName === TableName.ARTICLES) {
      return { Items: [{ ...success, approval: { revisionId: "changed" } }] };
    }
    if (input.ExclusiveStartKey)
      return { Items: [{ status: "pending", approvedSnapshot: success }] };
    return {
      Items: [
        { status: "pending" },
        {
          status: "approved",
          updatedAt: version,
          diskSync: { status: "failed", sourceUpdatedAt: version },
        },
        { updatedAt: version },
      ],
      LastEvaluatedKey: { id: "fixture-private-id" },
    };
  }, now);
  assert.equal(pages, 3);
  assert.deepEqual(report.cards, { pending: 1, failed: 1, synced: 1 });
  assert.deepEqual(report.articles, { pending: 1, failed: 0, synced: 0 });
  assert.equal(report.fresh, true);
  assert.equal(report.healthy, false);
  assert.equal(JSON.stringify(report).includes("fixture-private-id"), false);
  const empty = await checkDiskSync(async () => ({ Items: [] }), now);
  assert.equal(empty.healthy, false);
  assert.equal(empty.fresh, false);
  const old = await checkDiskSync(
    async (input) => ({
      Items: input.TableName === TableName.KNOWLEDGE_CARDS ? [success] : [],
    }),
    now + 24 * 3_600_000
  );
  assert.equal(old.fresh, false);
  const ok = await checkDiskSync(
    async (input) => ({
      Items: input.TableName === TableName.KNOWLEDGE_CARDS ? [success] : [],
    }),
    now
  );
  assert.equal(ok.healthy, true);
  await assert.rejects(
    checkDiskSync(async () => {
      throw new Error("fixture read unavailable");
    }, now)
  );
  console.log(
    "PASS approved export status, pagination, stale revisions, backlog and freshness"
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
