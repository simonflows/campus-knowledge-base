import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  captureDatabase,
  type DatabaseArchive,
  DatabaseBackupError,
  readDatabaseArchive,
  restoreDatabase,
  validateDatabaseEndpoint,
  writeDatabaseArchive,
} from "../lib/database-backup";

class BackupUsageError extends Error {}

function connection() {
  const endpoint = validateDatabaseEndpoint(process.env.DOCUMENT_API_ENDPOINT ?? "");
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const sessionToken = process.env.AWS_SESSION_TOKEN;
  if (!accessKeyId || !secretAccessKey) throw new DatabaseBackupError("configuration");

  const client = new DynamoDBClient({
    endpoint,
    region: process.env.DOCUMENT_API_REGION ?? "ru-central1",
    maxAttempts: 1,
    credentials: { accessKeyId, secretAccessKey, sessionToken },
  });
  return { client, endpoint };
}

function status(operation: string, archive: DatabaseArchive) {
  const tableCounts = Object.fromEntries(archive.tables.map(({ name, count }) => [name, count]));
  console.log(JSON.stringify({
    status: operation,
    tables: archive.tables.length,
    entries: archive.tables.reduce((total, table) => total + table.count, 0),
    tableCounts,
    sha256: archive.sha256,
  }));
}

async function run(args: string[]) {
  const [operation, archivePath, ...flags] = args;
  if (!archivePath || archivePath.startsWith("--")) throw new BackupUsageError();

  if (operation === "verify" && flags.length === 0) {
    status("verified", await readDatabaseArchive(archivePath));
    return;
  }

  if (
    operation === "snapshot" && flags.includes("--writers-stopped") &&
    new Set(flags).size === flags.length &&
    flags.every((flag) => flag === "--writers-stopped" || flag === "--pre-0.9.5")
  ) {
    const db = connection();
    try {
      const archive = await captureDatabase({
        ...db,
        scope: flags.includes("--pre-0.9.5") ? "pre-0.9.5" : "current",
      });
      await writeDatabaseArchive(archivePath, archive);
      status("saved", archive);
    } finally {
      db.client.destroy();
    }
    return;
  }

  const prefix = flags.length === 2 && flags[0] === "--prefix" ? flags[1] : undefined;
  const disasterRecovery = flags.length === 1 && flags[0] === "--disaster-recovery";
  if (operation === "restore" && (prefix || disasterRecovery)) {
    const archive = await readDatabaseArchive(archivePath);
    const db = connection();
    try {
      await restoreDatabase({ ...db, target: { prefix, disasterRecovery }, archive });
      status("restored", archive);
    } finally {
      db.client.destroy();
    }
    return;
  }

  throw new BackupUsageError();
}

run(process.argv.slice(2)).catch((error: unknown) => {
  const code = error instanceof DatabaseBackupError
    ? error.code
    : error instanceof BackupUsageError ? "usage" : "unexpected";
  console.error(JSON.stringify({ status: "error", code }));
  process.exitCode = 1;
});
