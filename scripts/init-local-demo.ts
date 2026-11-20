import {
  CreateTableCommand,
  ListTablesCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, type ScanCommandOutput } from "@aws-sdk/lib-dynamodb";
import { articleSeed } from "../lib/articles";
import { knowledgeSeedCards, type KnowledgeCard } from "../lib/knowledge";
import { missingUniversityPassports } from "../lib/knowledge-lifecycle";
import { TableName, TABLE_NAMES, TABLE_SCHEMAS } from "../lib/schema";

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

export async function seedLocalDemoCorpus(client: DynamoDBClient) {
  const documentClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const existingCards: KnowledgeCard[] = [];
  let cursor: ScanCommandOutput["LastEvaluatedKey"];
  do {
    const page: ScanCommandOutput = await documentClient.send(new ScanCommand({
      TableName: TableName.KNOWLEDGE_CARDS,
      ExclusiveStartKey: cursor,
      ProjectionExpression: "id, #type, universityId",
      ExpressionAttributeNames: { "#type": "type" },
    }));
    existingCards.push(...((page.Items ?? []) as KnowledgeCard[]));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  const articles = await documentClient.send(new ScanCommand({ TableName: TableName.ARTICLES, Limit: 1 }));
  const cards = existingCards.length ? missingUniversityPassports(existingCards) : knowledgeSeedCards;
  const records = [
    ...cards.map(item => [TableName.KNOWLEDGE_CARDS, item] as const),
    ...(articles.Items?.length || process.env.SEED_DEMO_ARTICLES === "false" ? [] : articleSeed)
      .map(item => [TableName.ARTICLES, item] as const),
  ];
  for (const [TableName, Item] of records) {
    try {
      await documentClient.send(new PutCommand({
        TableName,
        Item,
        ConditionExpression: "attribute_not_exists(id)",
      }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "ConditionalCheckFailedException") throw error;
    }
  }
}
