import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { articleSeed, type ReadyArticle } from "./articles";
import {
  knowledgeSeedCards,
  type CardTypeDefinition,
  type KnowledgeCard,
} from "./knowledge";

export interface LocalStoreData {
  seedVersion: number;
  cards: KnowledgeCard[];
  cardTypes: CardTypeDefinition[];
  articles: ReadyArticle[];
  demoArticlesCleared?: boolean;
}

const CURRENT_SEED_VERSION = 2;
const STORE_DIR = path.join(process.cwd(), ".data");
const STORE_PATH = path.join(STORE_DIR, "local-store.json");

let writeQueue: Promise<unknown> = Promise.resolve();

function createInitialStore(): LocalStoreData {
  const skipDemoArticles = process.env.SEED_DEMO_ARTICLES === "false";
  return {
    seedVersion: CURRENT_SEED_VERSION,
    cards: structuredClone(knowledgeSeedCards),
    cardTypes: [],
    articles: skipDemoArticles ? [] : structuredClone(articleSeed),
    demoArticlesCleared: skipDemoArticles,
  };
}

export class LocalStoreRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalStoreRecoveryError";
  }
}

export function parseLocalStore(raw: string): LocalStoreData {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new LocalStoreRecoveryError(
      "Локальные данные повреждены. Исходный файл сохранён без изменений; восстановите его из local-store.json.bak."
    );
  }
  const parsed = z
    .object({
      seedVersion: z.number().int(),
      cards: z.array(z.object({ id: z.string() }).passthrough()),
      articles: z.array(z.object({ id: z.string() }).passthrough()),
      cardTypes: z
        .array(z.object({ id: z.string() }).passthrough())
        .default([]),
      demoArticlesCleared: z.boolean().optional(),
    })
    .safeParse(value);
  if (
    !parsed.success ||
    parsed.data.seedVersion < 1 ||
    parsed.data.seedVersion > CURRENT_SEED_VERSION
  )
    throw new LocalStoreRecoveryError(
      "Формат локальных данных неизвестен. Файл сохранён без изменений; автоматическая замена демонстрационными данными запрещена."
    );
  return {
    ...parsed.data,
    seedVersion: CURRENT_SEED_VERSION,
  } as LocalStoreData;
}

function requireLocalDemo() {
  if (
    process.env.CAMPUS_LOCAL_DEMO !== "true" ||
    process.env.NODE_ENV === "production"
  )
    throw new Error(
      "Локальная запись доступна только в явно включённом деморежиме."
    );
}

export async function getLocalStoreReadProblem(): Promise<string | null> {
  try {
    parseLocalStore(await fs.readFile(STORE_PATH, "utf8"));
    return null;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    return error instanceof LocalStoreRecoveryError
      ? error.message
      : "Не удалось прочитать локальный файл. Исходные данные сохранены; проверьте доступ к .data/local-store.json.";
  }
}

export async function readLocalStore(): Promise<LocalStoreData> {
  requireLocalDemo();
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    return parseLocalStore(raw);
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw error;
    const fresh = createInitialStore();
    await fs.mkdir(STORE_DIR, { recursive: true });
    try {
      await fs.writeFile(STORE_PATH, JSON.stringify(fresh, null, 2), {
        encoding: "utf8",
        flag: "wx",
      });
      return fresh;
    } catch (writeError) {
      if (
        writeError &&
        typeof writeError === "object" &&
        "code" in writeError &&
        writeError.code === "EEXIST"
      )
        return parseLocalStore(await fs.readFile(STORE_PATH, "utf8"));
      throw writeError;
    }
  }
}

export async function writeLocalStore(data: LocalStoreData): Promise<void> {
  requireLocalDemo();
  await fs.mkdir(STORE_DIR, { recursive: true });
  const tempPath = `${STORE_PATH}.${crypto.randomUUID()}.tmp`;
  // Validate and retain the last valid file before replacing it. Corruption is never reset.
  try {
    const previous = await fs.readFile(STORE_PATH, "utf8");
    parseLocalStore(previous);
    const backupTemp = `${tempPath}.bak`;
    await fs.writeFile(backupTemp, previous, "utf8");
    await fs.rename(backupTemp, `${STORE_PATH}.bak`);
  } catch (error) {
    if (
      !(
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
    )
      throw error;
  }
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), "utf8");
  await fs.rename(tempPath, STORE_PATH);
}

export async function mutateLocalStore<T>(
  mutator: (
    store: LocalStoreData
  ) =>
    | Promise<{ store: LocalStoreData; result: T }>
    | { store: LocalStoreData; result: T }
): Promise<T> {
  const task = writeQueue.then(async () => {
    const current = await readLocalStore();
    const { store, result } = await mutator(current);
    await writeLocalStore(store);
    return result;
  });

  writeQueue = task.catch(() => undefined);
  return task;
}
