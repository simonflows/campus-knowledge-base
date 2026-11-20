import {
  CreateTableCommand,
  ListTablesCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { TABLE_NAMES, TABLE_SCHEMAS } from "../lib/schema";

export async function ensureLocalDemoTables(client: DynamoDBClient) {
  const { TableNames = [] } = await client.send(new ListTablesCommand({}));
  for (const name of TABLE_NAMES) {
    if (TableNames.includes(name)) continue;
    const { keySchema, attributeDefinitions, globalSecondaryIndexes } =
      TABLE_SCHEMAS[name];
    await client.send(
      new CreateTableCommand({
        TableName: name,
        KeySchema: keySchema,
        AttributeDefinitions: attributeDefinitions,
        ...(globalSecondaryIndexes?.length && {
          GlobalSecondaryIndexes: globalSecondaryIndexes,
        }),
        BillingMode: "PAY_PER_REQUEST",
      })
    );
  }
}
