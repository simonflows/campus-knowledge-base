import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { docClient } from "../lib/db";
import { checkDeployStorage } from "../lib/deploy-storage";

const problemLabels = {
  missing: "таблица отсутствует. Проверьте миграцию и выбранную базу.",
  inactive: "таблица ещё не активна.",
  "key-schema": "схема ключа отличается от ожидаемой.",
  unavailable:
    "описание недоступно. Проверьте права, сеть и адрес Document API.",
};

async function main() {
  const required = [
    "DOCUMENT_API_ENDPOINT",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ];
  const absent = required.filter((name) => !process.env[name]?.trim());
  if (absent.length > 0 || process.env.USE_DATABASE === "false") {
    const reason =
      absent.length > 0
        ? `Нужны настройки ${absent.join(", ")}.`
        : "Подключение к базе отключено.";
    console.error(reason);
    process.exitCode = 1;
    return;
  }

  const issues = await checkDeployStorage(async (TableName) => {
    const output = await docClient.send(
      new DescribeTableCommand({ TableName }),
      {
        abortSignal: AbortSignal.timeout(5_000),
      }
    );
    return output.Table;
  });
  if (issues.length > 0) {
    for (const { table, problem } of issues) {
      console.error(`${table} — ${problemLabels[problem]}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    "Таблицы Document API доступны и имеют ожидаемые первичные ключи."
  );
}

main()
  .catch(() => {
    console.error("Не удалось проверить таблицы Document API.");
    process.exitCode = 1;
  })
  .finally(() => docClient.destroy());
