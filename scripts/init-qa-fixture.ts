import assert from "node:assert/strict";
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { ensureLocalDemoTables, seedLocalDemoCorpus } from "./init-local-demo";
import { markDisposableFixture, requireDisposableDatabase } from "./qa-fixture";

async function main() {
  requireDisposableDatabase();
  const client = new DynamoDBClient({
    endpoint: process.env.DOCUMENT_API_ENDPOINT,
    region: process.env.DOCUMENT_API_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: "campusLocalTest",
      secretAccessKey: "localTestOnly",
    },
  });
  try {
    const { TableNames } = await client.send(new ListTablesCommand({ Limit: 1 }));
    assert.equal(TableNames?.length ?? 0, 0, "Use a fresh disposable database for each run");
    await ensureLocalDemoTables(client);
    await seedLocalDemoCorpus(client);
    await markDisposableFixture();
  } finally {
    client.destroy();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Fixture initialization failed");
  process.exitCode = 1;
});
