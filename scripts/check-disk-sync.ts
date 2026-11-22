import {
  ScanCommand,
  type ScanCommandInput,
  type ScanCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { TableName } from "../lib/schema";

type ScanPage = (
  input: ScanCommandInput
) => Promise<Pick<ScanCommandOutput, "Items" | "LastEvaluatedKey">>;

type ExportRecord = {
  updatedAt?: string;
  status?: string;
  approvedSnapshot?: ExportRecord;
  approval?: { revisionId?: string };
  diskSync?: {
    status?: string;
    sourceUpdatedAt?: string;
    sourceRevisionId?: string;
    lastSyncedAt?: string;
  };
};

const versionFields = [
  "updatedAt",
  "#status",
  "diskSync.#status",
  "diskSync.sourceUpdatedAt",
  "diskSync.lastSyncedAt",
];

export async function checkDiskSync(scan: ScanPage, now = Date.now()) {
  let latestSuccess = -Infinity;
  async function countTable(
    table: typeof TableName.KNOWLEDGE_CARDS | typeof TableName.ARTICLES
  ) {
    const counts = { pending: 0, failed: 0, synced: 0 };
    const isArticle = table === TableName.ARTICLES;
    const fields = isArticle
      ? [...versionFields, "approval.revisionId", "diskSync.sourceRevisionId"]
      : [
          ...versionFields,
          ...versionFields.map((field) => `approvedSnapshot.${field}`),
        ];
    let cursor: ScanCommandInput["ExclusiveStartKey"];
    do {
      const page = await scan({
        TableName: table,
        ExclusiveStartKey: cursor,
        ConsistentRead: true,
        ProjectionExpression: fields.join(", "),
        ExpressionAttributeNames: { "#status": "status" },
        ...(isArticle && {
          FilterExpression: [
            "approval.revisionId",
            "approval.approvedBy",
            "approval.approvedAt",
          ]
            .map((field) => `attribute_exists(${field}) AND ${field} <> :empty`)
            .join(" AND "),
          ExpressionAttributeValues: { ":empty": "" },
        }),
      });
      for (const item of (page.Items ?? []) as ExportRecord[]) {
        const published =
          isArticle || (item.status ?? "approved") === "approved"
            ? item
            : item.approvedSnapshot;
        if (
          !published ||
          (!isArticle && (published.status ?? "approved") !== "approved")
        )
          continue;
        const sync = published.diskSync;
        const lastSync = Date.parse(sync?.lastSyncedAt ?? "");
        if (Number.isFinite(lastSync) && lastSync <= now)
          latestSuccess = Math.max(latestSuccess, lastSync);
        const sameVersion = Boolean(
          published.updatedAt &&
          sync?.sourceUpdatedAt === published.updatedAt &&
          (!isArticle ||
            (published.approval?.revisionId &&
              published.approval.revisionId === sync.sourceRevisionId))
        );
        if (
          sameVersion &&
          sync?.status === "synced" &&
          Number.isFinite(lastSync) &&
          lastSync <= now
        )
          counts.synced++;
        else if (sameVersion && sync?.status === "failed") counts.failed++;
        else counts.pending++;
      }
      cursor = page.LastEvaluatedKey;
    } while (cursor);
    return counts;
  }
  const [cards, articles] = await Promise.all([
    countTable(TableName.KNOWLEDGE_CARDS),
    countTable(TableName.ARTICLES),
  ]);
  const fresh = now - latestSuccess <= 24 * 3_600_000;
  return {
    cards,
    articles,
    lastSuccessfulExportAt: Number.isFinite(latestSuccess)
      ? new Date(latestSuccess).toISOString()
      : null,
    fresh,
    healthy:
      fresh &&
      !cards.pending &&
      !cards.failed &&
      !articles.pending &&
      !articles.failed,
  };
}

async function main() {
  if (
    !process.env.DOCUMENT_API_ENDPOINT ||
    process.env.USE_DATABASE === "false"
  )
    throw new Error("Database unavailable");
  const { docClient } = await import("../lib/db");
  const deadline = AbortSignal.timeout(60_000);
  try {
    const report = await checkDiskSync((input) =>
      docClient.send(new ScanCommand(input), { abortSignal: deadline })
    );
    console.log(JSON.stringify(report));
    process.exitCode = report.healthy ? 0 : 1;
  } finally {
    docClient.destroy();
  }
}

if (require.main === module) {
  main().catch(() => {
    console.error("Не удалось прочитать состояние выгрузок из общей базы.");
    process.exitCode = 2;
  });
}
