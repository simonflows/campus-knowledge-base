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
