import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { docClient, getStorageMode } from "./db";
import type { TableDescription } from "@aws-sdk/client-dynamodb";
import { TABLE_NAMES, TABLE_SCHEMAS, type TableName } from "./schema";

type TableProblem = {
  table: TableName;
  problem: "missing" | "inactive" | "key-schema" | "unavailable";
};

export async function checkDeployStorage(
  describeTable: (name: TableName) => Promise<TableDescription | undefined>
): Promise<TableProblem[]> {
  const results = await Promise.all(
    TABLE_NAMES.map(async (table): Promise<TableProblem | null> => {
      let description: TableDescription | undefined;
      try {
        description = await describeTable(table);
      } catch (error) {
        return {
          table,
          problem:
            error instanceof Error && error.name === "ResourceNotFoundException"
              ? "missing"
              : "unavailable",
        };
      }
      if (!description) return { table, problem: "unavailable" };
      if (description.TableStatus !== "ACTIVE") {
        return { table, problem: "inactive" };
      }

      const expected = TABLE_SCHEMAS[table];
      const keys = description.KeySchema ?? [];
      const attributes = description.AttributeDefinitions ?? [];
      const keyMatches =
        keys.length === expected.keySchema.length &&
        expected.keySchema.every(({ AttributeName, KeyType }) =>
          keys.some(
            (key) =>
              key.AttributeName === AttributeName && key.KeyType === KeyType
          )
        ) &&
        expected.attributeDefinitions.every(
          ({ AttributeName, AttributeType }) =>
            attributes.some(
              (attribute) =>
                attribute.AttributeName === AttributeName &&
                attribute.AttributeType === AttributeType
            )
        );
      return keyMatches ? null : { table, problem: "key-schema" };
    })
  );
  return results.filter((result) => result !== null);
}

/** Exercise the same runtime mode and primary keys used by the application. */
export async function isRuntimeStorageReady(): Promise<boolean> {
  const state = globalThis as unknown as { _campusReadinessInFlight?: Promise<boolean> };
  if (state._campusReadinessInFlight) return state._campusReadinessInFlight;
  const probe = async () => {
    try {
      if ((await getStorageMode()) !== "dynamodb") return false;
      // Share only the active probe. Wait for every sibling even on failure so
      // another caller cannot start a second batch while reads are still pending.
      const results = await Promise.allSettled(
        TABLE_NAMES.map(async (TableName) =>
          docClient.send(
            new GetCommand({
              TableName,
              Key: { id: "__campus_readiness__" },
              ProjectionExpression: "id",
              ConsistentRead: true,
            }),
            { abortSignal: AbortSignal.timeout(2500) }
          )
        )
      );
      return results.every(result => result.status === "fulfilled");
    } catch {
      return false;
    }
  };
  const pending = probe().finally(() => {
    if (state._campusReadinessInFlight === pending) delete state._campusReadinessInFlight;
  });
  state._campusReadinessInFlight = pending;
  return pending;
}

/** The comparison workspace uses a labelled fixture in explicit demo modes. */
export async function getComparisonStorageMode() {
  const mode = await getStorageMode();
  if (mode === "dynamodb") return (await isRuntimeStorageReady()) ? mode : null;
  return mode === "read-only" ? null : mode;
}
