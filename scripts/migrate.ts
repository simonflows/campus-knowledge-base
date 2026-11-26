import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTimeToLiveCommand,
  UpdateTimeToLiveCommand,
  paginateListTables,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { TABLE_SCHEMAS, TABLE_NAMES } from "../lib/schema";

async function ensureTtl(client: DynamoDBClient, name: string, attribute: string, log: (line: string) => void) {
  const { TimeToLiveDescription: ttl } = await client.send(new DescribeTimeToLiveCommand({ TableName: name }));
  const { TimeToLiveStatus: status, AttributeName: observedAttribute } = ttl ?? {};
  if (status === "ENABLED" || status === "ENABLING") {
    if (observedAttribute !== attribute)
      throw new Error(`${name}: атрибут TTL ${observedAttribute ?? "не указан"}, ожидается ${attribute}`);
    log(`  ✓ TTL ${name}: ${attribute}, ${status}`);
    return;
  }
  if (status !== "DISABLED")
    throw new Error(`${name}: неожиданный статус TTL ${status ?? "не указан"}`);

  const { TimeToLiveSpecification: configured } = await client.send(new UpdateTimeToLiveCommand({
    TableName: name, TimeToLiveSpecification: { AttributeName: attribute, Enabled: true },
  }));
  if (configured?.Enabled !== true || configured.AttributeName !== attribute)
    throw new Error(`${name}: YDB не подтвердила включение TTL по атрибуту ${attribute}`);
  log(`  ✓ TTL ${name}: включение по атрибуту ${attribute} запрошено`);
}

export async function migrate(client: DynamoDBClient, log: (line: string) => void = console.log) {
  log("🔧 Запуск миграций DynamoDB...");
  const existing = new Set<string>();
  for await (const page of paginateListTables({ client }, {})) {
    for (const name of page.TableNames ?? []) existing.add(name);
  }

  for (const name of TABLE_NAMES) {
    const table = TABLE_SCHEMAS[name];
    const alreadyExists = existing.has(name);
    if (alreadyExists) {
      log(`  ✓ Таблица существует: ${name}`);
    } else {
      log(`  Создание таблицы: ${name}...`);
      await client.send(new CreateTableCommand({
        TableName: name,
        KeySchema: table.keySchema,
        AttributeDefinitions: table.attributeDefinitions,
        ...(table.globalSecondaryIndexes?.length
          ? { GlobalSecondaryIndexes: table.globalSecondaryIndexes }
          : {}),
        BillingMode: "PAY_PER_REQUEST",
      }));
    }

    if (!alreadyExists || table.ttlAttribute) {
      log(`  Ожидание активации ${name}...`);
      await waitUntilTableExists({ client, maxWaitTime: 120 }, { TableName: name });
    }
    if (!alreadyExists) log(`  ✓ Создана: ${name}`);
    if (table.ttlAttribute) await ensureTtl(client, name, table.ttlAttribute, log);
  }

  log("🎉 Миграции завершены!");
}

if (require.main === module) {
  const client = new DynamoDBClient({
    endpoint: process.env.DOCUMENT_API_ENDPOINT,
    region: process.env.DOCUMENT_API_REGION ?? "ru-central1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
    },
  });
  void migrate(client).catch((error: unknown) => {
    console.error("❌ Ошибка миграции:", error instanceof Error ? `${error.name}: ${error.message}` : "неизвестная ошибка");
    process.exitCode = 1;
  }).finally(() => { client.destroy(); });
}
