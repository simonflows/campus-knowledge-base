import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const globalForDb = globalThis as unknown as {
  docClient: DynamoDBDocumentClient | undefined;
};

function createDocClient() {
  const client = new DynamoDBClient({
    endpoint: process.env.DOCUMENT_API_ENDPOINT,
    region: process.env.DOCUMENT_API_REGION ?? "ru-central1",
    maxAttempts: 1,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    },
  });

  return DynamoDBDocumentClient.from(client);
}

export const docClient = globalForDb.docClient ?? createDocClient();

if (process.env.NODE_ENV !== "production") globalForDb.docClient = docClient;

const globalForDbAvailable = globalThis as unknown as {
  _dbAvailable: boolean | null;
  _dbAvailablePromise: Promise<boolean> | null;
  _dbAvailableCheckedAt: number | undefined;
};

export async function isDatabaseAvailable(): Promise<boolean> {
  if (process.env.USE_DATABASE === "false") {
    return false;
  }

  // If neither a custom endpoint nor real AWS/YDB credentials are provided, skip network probe
  if (
    !process.env.DOCUMENT_API_ENDPOINT &&
    !process.env.AWS_ACCESS_KEY_ID &&
    !process.env.AWS_SECRET_ACCESS_KEY
  ) {
    return false;
  }

  if (
    globalForDbAvailable._dbAvailable != null &&
    Date.now() - (globalForDbAvailable._dbAvailableCheckedAt ?? 0) <
      (globalForDbAvailable._dbAvailable ? 30_000 : 5_000)
  ) {
    return globalForDbAvailable._dbAvailable;
  }

  if (globalForDbAvailable._dbAvailablePromise) {
    return globalForDbAvailable._dbAvailablePromise;
  }

  const promise = (async () => {
    try {
      await docClient.send(new ListTablesCommand({}), {
        abortSignal: AbortSignal.timeout(2_500),
      });
      globalForDbAvailable._dbAvailable = true;
      return true;
    } catch {
      console.warn(
        "DynamoDB / YDB Document API недоступен. Запись в общую базу отключена."
      );
      globalForDbAvailable._dbAvailable = false;
      return false;
    } finally {
      globalForDbAvailable._dbAvailableCheckedAt = Date.now();
      globalForDbAvailable._dbAvailablePromise = null;
    }
  })();

  globalForDbAvailable._dbAvailablePromise = promise;
  return promise;
}

export type StorageMode =
  | "dynamodb"
  | "local-json"
  | "static-export"
  | "read-only";

export function resolveStorageMode(options: {
  available: boolean;
  outputMode?: string;
  localDemo?: string;
  nodeEnv?: string;
}): StorageMode {
  if (options.outputMode === "export") return "static-export";
  if (options.localDemo === "true" && options.nodeEnv !== "production")
    return "local-json";
  if (options.available) return "dynamodb";
  return "read-only";
}

export async function getStorageMode(): Promise<StorageMode> {
  if (process.env.OUTPUT_MODE === "export") {
    return "static-export";
  }
  if (
    process.env.CAMPUS_LOCAL_DEMO === "true" &&
    process.env.NODE_ENV !== "production"
  ) {
    const { getLocalStoreReadProblem } = await import("./local-store");
    return (await getLocalStoreReadProblem()) ? "read-only" : "local-json";
  }

  if (await isDatabaseAvailable()) {
    return "dynamodb";
  }

  return resolveStorageMode({
    available: false,
    localDemo: process.env.CAMPUS_LOCAL_DEMO,
    nodeEnv: process.env.NODE_ENV,
  });
}

export async function isStorageWritable(): Promise<boolean> {
  const mode = await getStorageMode();
  return mode === "dynamodb" || mode === "local-json";
}

export async function getWritableStorageMode(): Promise<
  "dynamodb" | "local-json"
> {
  const mode = await getStorageMode();
  if (mode === "dynamodb" || mode === "local-json") return mode;
  throw new Error(
    "Общая база недоступна; запись отключена. Локальное демо включается отдельно."
  );
}

export function resetDbAvailableCache(): void {
  globalForDbAvailable._dbAvailable = null;
  globalForDbAvailable._dbAvailablePromise = null;
  globalForDbAvailable._dbAvailableCheckedAt = undefined;
}
