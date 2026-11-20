import { readFile } from "node:fs/promises";
import { docClient } from "../lib/db";
import {
  importApprovedKnowledge,
  ImportValidationError,
} from "../lib/knowledge-import";

async function main() {
  const args = process.argv.slice(2);
  const [file, flag] = args;
  if (
    !file ||
    file.startsWith("-") ||
    args.length > 2 ||
    (flag !== undefined && flag !== "--apply")
  ) {
    throw new ImportValidationError(
      "Использование: tsx scripts/import-approved-knowledge.ts <файл.json> [--apply]"
    );
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new ImportValidationError(
      "Не удалось прочитать указанный JSON-файл."
    );
  }
  const apply = flag === "--apply";
  const result = await importApprovedKnowledge(manifest, apply);
  console.log(
    apply
      ? `Добавлено: ${result.inserted}. Сохранено существующих: ${result.preserved}.`
      : `Проверено карточек: ${result.validated}. Для записи добавьте --apply.`
  );
}

main()
  .catch((error) => {
    // SDK failures may include endpoint or request details.
    console.error(
      error instanceof ImportValidationError
        ? error.message
        : "Ошибка импорта. Проверьте права и доступность базы. Файл можно применить повторно."
    );
    process.exitCode = 1;
  })
  .finally(() => docClient.destroy());
