import { createHash } from "node:crypto";
import { isApprovedArticle, type ReadyArticle } from "./articles";
import { createPendingDiskSync, type DiskSyncInfo } from "./disk-sync";
import {
  folderIds,
  getCardTypeLabel,
  getFolderPath,
  getUniversityName,
  getApprovedVersion,
  isCardApproved,
  type CardTypeDefinition,
  type KnowledgeCard,
} from "./knowledge";

const DISK_API_BASE = "https://cloud-api.yandex.net/v1/disk";
const DISK_ROOT = "disk:";
const REQUEST_TIMEOUT_MS = 30_000;

export const DISK_CARD_SUMMARY_FILE = "_Сводная_таблица_карточек.csv";
export const DISK_ARTICLE_SUMMARY_FILE = "_Сводная_таблица_статей.csv";
export const DISK_RESTORE_GUIDE = `# Как читать резервную копию без приложения

Имена MD и CSV начинаются с версии данных в ISO UTC (двоеточия заменены дефисами). Сортируйте по имени, а не по дате загрузки: старая попытка может завершиться позже новой.

В нужной папке откройте CSV с наибольшей меткой согласованного снимка. В каждой строке указаны ID, согласованная версия, путь к её неизменяемому MD и состояние выгрузки. Если указано «Ожидает выгрузки», эта редакция ещё не является полной резервной копией. Одинаковые временные метки с разными хешами — отдельные снимки; сравните версии строк, не удаляя файлы.

Совместные проекты хранятся едиными MD в 02_Совместные_проекты. В папках вузов находятся только .link.md указатели с ID, версией и путём к этой карточке. Новую редакцию можно считать полностью выгруженной после успешной записи MD, указателей и CSV. Повтор после ошибки пишет те же файлы этой версии; предыдущие версии сохраняются.

В CSV и MD публикуются только утверждённые карточки и согласованные статьи. Пока правка карточки проходит согласование, в реестре остаётся предыдущая утверждённая версия. Личные черновики не являются частью этого дерева. Показатели вузов находятся в собственных паспортах с годом, единицей, статусом факт/план, документом, датой проверки и ответственным.

Для восстановления сохраните исходное дерево отдельно и передайте координатору нужные MD и CSV. Автоматического перезаписывания рабочей базы при восстановлении нет.
`;

export class YandexDiskError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "YandexDiskError";
  }
}

export function isYandexDiskConfigured(): boolean {
  return Boolean(process.env.YANDEX_DISK_OAUTH_TOKEN);
}

function getToken(): string {
  const token = process.env.YANDEX_DISK_OAUTH_TOKEN;

  if (!token) {
    throw new YandexDiskError(
      "Не настроен YANDEX_DISK_OAUTH_TOKEN: выгрузка на Яндекс Диск недоступна."
    );
  }

  return token;
}

function sanitizeFileName(value: string): string {
  const cleaned = value
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  return cleaned || "without-name";
}

function toDisplayPath(segments: string[]): string {
  return segments.join("/");
}

function toResourcePath(segments: string[]): string {
  return `${DISK_ROOT}/${segments.join("/")}`;
}

export function getCardDiskFolderSegments(card: KnowledgeCard): string[] {
  const path = getFolderPath(card.folderId);

  if (path.length > 0) {
    return path.map((node) => node.name);
  }

  const customPrefix = `${folderIds.customRoot}/`;

  if (card.folderId.startsWith(customPrefix)) {
    return [
      "03_Пользовательские_типы",
      card.folderId.slice(customPrefix.length),
    ];
  }

  return ["99_Прочее"];
}

export function getArticleDiskFolderSegments(article: ReadyArticle): string[] {
  return [
    "01_Вузы_резиденты",
    getUniversityName(article.universityId),
    "Готовые_статьи",
  ];
}

function escapeCsv(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[\s]*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildCsv(
  rows: Array<Array<string | number | null | undefined>>
): string {
  return `\uFEFF${rows.map((row) => row.map(escapeCsv).join(";")).join("\r\n")}\r\n`;
}

function stringifyFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

function versionStamp(updatedAt: string): string {
  return new Date(updatedAt).toISOString().replace(/:/g, "-");
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

export function getKnowledgeCardBackupFileName(
  card: KnowledgeCard,
  customTypes: CardTypeDefinition[] = []
): string {
  return `${versionStamp(card.updatedAt)}--${sanitizeFileName(card.title)}--${sanitizeFileName(card.id)}--${contentHash(card.updatedAt + buildKnowledgeCardMarkdown(card, customTypes))}.md`;
}

export function getArticleBackupFileName(article: ReadyArticle): string {
  return `${versionStamp(article.updatedAt)}--${sanitizeFileName(article.title)}--${sanitizeFileName(article.id)}--${contentHash((article.approval?.revisionId ?? "") + buildArticleMarkdown(article))}.md`;
}

function snapshotVersion(items: Array<{ updatedAt: string }>): string {
  return (
    items
      .map((item) => item.updatedAt)
      .sort()
      .at(-1) ?? "1970-01-01T00:00:00.000Z"
  );
}

export function buildKnowledgeCardMarkdown(
  card: KnowledgeCard,
  customTypes: CardTypeDefinition[] = []
): string {
  const lines: string[] = [
    `# ${card.title}`,
    "",
    `- ID: ${card.id}`,
    `- Тип: ${getCardTypeLabel(card, customTypes)}`,
    `- Папка: ${getCardFolderLabel(card)}`,
    `- Владельцы: ${card.owners.join(", ")}`,
    `- Обновлено: ${card.updatedAt}`,
    "",
    "## Эталонное описание",
    "",
    card.referenceDescription || "Не заполнено.",
    "",
    "## Ограничения для ИИ (стоп-формула)",
    "",
    card.stopFormula || "Не заполнено.",
    "",
  ];

  if (card.type === "project") {
    lines.push(
      "## Параметры проекта",
      "",
      `- Сфера / отрасль: ${card.sphere}`,
      `- Вуз-инициатор: ${getUniversityName(card.initiatorUniversityId)}`,
      `- Соисполнители: ${card.coExecutors.join(", ") || "нет"}`,
      `- Индустриальный партнёр: ${card.industrialPartner}`,
      `- Стадия готовности: ${card.readinessStage}`,
      `- Контур: ${card.contour}`,
      `- Совместный проект: ${card.isJoint ? "да" : "нет"}`,
      `- Вузы-участники: ${
        card.participantUniversityIds.map(getUniversityName).join(", ") || "нет"
      }`,
      "",
      "## Подтверждённые цифры",
      "",
      card.confirmedFigures.length > 0
        ? card.confirmedFigures.map((item) => `- ${item}`).join("\n")
        : "Не указаны.",
      ""
    );
  }

  if (card.type === "laboratory") {
    lines.push(
      "## Параметры лаборатории",
      "",
      `- Принадлежность: ${card.affiliation}`,
      `- Партнёр: ${card.partner}`,
      `- Руководитель: ${card.head}`,
      `- Статус размещения: ${card.placementDetails}`,
      "",
      "## Направления работ",
      "",
      card.workDirections.length > 0
        ? card.workDirections.map((item) => `- ${item}`).join("\n")
        : "Не указаны.",
      "",
      "## Оборудование",
      "",
      card.equipment.length > 0
        ? card.equipment.map((item) => `- ${item}`).join("\n")
        : "Не указано.",
      "",
      "## Подтверждённые показатели",
      "",
      card.confirmedIndicators.length > 0
        ? card.confirmedIndicators.map((item) => `- ${item}`).join("\n")
        : "Не указаны.",
      ""
    );
  }

  if (card.type === "campus") {
    lines.push(
      "## Показатели кампуса",
      "",
      ...card.campusMetrics.map(
        (metric) => `- ${metric.label}: ${metric.value} (${metric.note})`
      ),
      "",
      "## Тарифы",
      "",
      ...card.tariffs.map((tariff) => `- ${tariff.label}: ${tariff.value}`),
      "",
      "## Юридические лица",
      "",
      ...card.legalEntities.map(
        (entity) => `- ${entity.name} — ${entity.role}`
      ),
      "",
      "## Стоп-лист частых ошибок",
      "",
      ...card.stopList.map((item) => `- ${item}`),
      ""
    );
  }

  if (card.type === "custom") {
    const customType = customTypes.find(
      (type) => type.id === card.customTypeId
    );
    const fields = customType?.fields ?? [];

    lines.push("## Поля карточки", "");

    if (fields.length > 0) {
      fields.forEach((field) => {
        lines.push(
          `- ${field.name}: ${stringifyFieldValue(card.customFields[field.id]) || "не заполнено"}`
        );
      });
    } else {
      Object.entries(card.customFields).forEach(([key, value]) => {
        lines.push(`- ${key}: ${stringifyFieldValue(value) || "не заполнено"}`);
      });
    }

    lines.push("");
  }

  if (card.type === "university") {
    lines.push(
      "## Показатели вуза",
      "",
      `- Вуз: ${getUniversityName(card.universityId)}`,
      ...card.structuredMetrics.map(
        (metric) =>
          `- ${metric.label}: ${metric.value} ${metric.unit}; год: ${metric.year}; ${metric.kind === "plan" ? "план" : "факт"}; документ: ${metric.evidenceUrl}; проверено: ${metric.verifiedAt}; ответственный: ${metric.owner}`
      ),
      ""
    );
  }

  return `${lines.join("\n").trim()}\n`;
}

function getCardFolderLabel(card: KnowledgeCard): string {
  const path = getFolderPath(card.folderId);

  if (path.length > 0) {
    return path.map((node) => node.name).join(" / ");
  }

  return card.folderId;
}

export function buildArticlesSummaryCsv(
  article: ReadyArticle,
  allArticles: ReadyArticle[]
): string {
  const universityId = article.universityId;
  const rows: Array<Array<string | number | null | undefined>> = [
    [
      "ID",
      "Название",
      "Вуз",
      "Проект",
      "Тема",
      "Карточки-источники",
      "Обновлено",
      "Согласованная редакция",
      "Путь к неизменяемому MD",
      "Согласованный снимок реестра (UTC)",
      "Состояние MD",
    ],
    ...allArticles
      .filter(
        (item) => isApprovedArticle(item) && item.universityId === universityId
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => [
        item.id,
        item.title,
        getUniversityName(item.universityId),
        item.projectTitle,
        item.topic,
        item.sourceCardTitles.join(", "),
        item.updatedAt,
        item.approval!.revisionId,
        item.id !== article.id &&
        item.diskSync?.sourceRevisionId === item.approval!.revisionId &&
        item.diskSync.fileUploaded &&
        item.diskSync.filePath
          ? item.diskSync.filePath
          : toDisplayPath([
              ...getArticleDiskFolderSegments(item),
              getArticleBackupFileName(item),
            ]),
        snapshotVersion(allArticles.filter(isApprovedArticle)),
        item.id === article.id ||
        (item.diskSync?.status === "synced" &&
          item.diskSync.sourceRevisionId === item.approval!.revisionId)
          ? "Выгружена"
          : "Ожидает выгрузки",
      ]),
  ];

  return buildCsv(rows);
}

export function buildKnowledgeCardsSummaryCsv(
  card: KnowledgeCard,
  allCards: KnowledgeCard[],
  customTypes: CardTypeDefinition[] = []
): string {
  const targetFolder = getCardDiskFolderSegments(card).join("/");
  const rows: Array<Array<string | number | null | undefined>> = [
    [
      "ID",
      "Название",
      "Тип",
      "Папка",
      "Владельцы",
      "Обновлено (UTC)",
      "Путь к неизменяемому MD",
      "Согласованный снимок реестра (UTC)",
      "Состояние MD",
    ],
    ...allCards
      .map(getApprovedVersion)
      .filter((item): item is KnowledgeCard => item !== null)
      .filter(
        (item) => getCardDiskFolderSegments(item).join("/") === targetFolder
      )
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((item) => [
        item.id,
        item.title,
        item.type,
        getCardDiskFolderSegments(item).join(" / "),
        item.owners.join(", "),
        item.updatedAt,
        item.id !== card.id &&
        item.diskSync?.sourceUpdatedAt === item.updatedAt &&
        item.diskSync.fileUploaded &&
        item.diskSync.filePath
          ? item.diskSync.filePath
          : toDisplayPath([
              ...getCardDiskFolderSegments(item),
              getKnowledgeCardBackupFileName(item, customTypes),
            ]),
        snapshotVersion(
          allCards
            .map(getApprovedVersion)
            .filter((item): item is KnowledgeCard => item !== null)
        ),
        item.id === card.id ||
        (item.diskSync?.status === "synced" &&
          item.diskSync.sourceUpdatedAt === item.updatedAt)
          ? "Выгружена"
          : "Ожидает выгрузки",
      ]),
  ];

  return buildCsv(rows);
}

export function buildArticleMarkdown(article: ReadyArticle): string {
  const lines: string[] = [
    `# ${article.title}`,
    "",
    `- ID: ${article.id}`,
    `- Согласованная версия (UTC): ${article.updatedAt}`,
    `- Редакция: ${article.approval?.revisionId ?? "не согласована"}`,
    `- Согласовано: ${article.approval?.approvedAt ?? "нет"}`,
    `- Координатор: ${article.approval?.approvedBy ?? "нет"}`,
    `- ID карточек-источников: ${article.sourceCardIds.join(", ")}`,
    "",
    article.lead,
    "",
  ];

  article.sections.forEach((section) => {
    lines.push(`${section.level === 3 ? "###" : "##"} ${section.heading}`, "");
    section.chunks.forEach((chunk) => {
      lines.push(chunk.content, "");
    });
  });

  lines.push(
    "## Карточки-источники",
    "",
    article.sourceCardTitles.length > 0
      ? article.sourceCardTitles.map((title) => `- ${title}`).join("\n")
      : "Источники не указаны.",
    ""
  );

  return `${lines.join("\n").trim()}\n`;
}

function describeDiskError(error: unknown): string {
  if (error instanceof YandexDiskError) {
    if (error.status === 401) {
      return "Яндекс Диск отклонил токен YANDEX_DISK_OAUTH_TOKEN. Проверьте права доступа.";
    }
    if (error.status === 403) {
      return "У токена нет прав на запись в указанную папку Яндекс Диска.";
    }
    if (error.status === 507) {
      return "На Яндекс Диске закончилось место.";
    }

    return error.message;
  }

  return "Не удалось связаться с Яндекс Диском.";
}

async function diskRequest(
  token: string,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      headers: {
        Authorization: `OAuth ${token}`,
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (error) {
    throw new YandexDiskError(describeDiskError(error));
  }
}

async function ensureFolder(token: string, segments: string[]): Promise<void> {
  let current = DISK_ROOT;

  for (const segment of segments) {
    current = `${current}/${segment}`;
    const response = await diskRequest(
      token,
      `${DISK_API_BASE}/resources?path=${encodeURIComponent(current)}`,
      { method: "PUT" }
    );

    if (!response.ok && response.status !== 409) {
      throw new YandexDiskError(
        `Не удалось создать папку «${current}» (HTTP ${response.status})`,
        response.status
      );
    }
  }
}

async function uploadFile(
  token: string,
  segments: string[],
  fileName: string,
  content: string,
  contentType: string
): Promise<string> {
  await ensureFolder(token, segments);

  const resourcePath = toResourcePath([...segments, fileName]);
  const uploadResponse = await diskRequest(
    token,
    `${DISK_API_BASE}/resources/upload?path=${encodeURIComponent(
      resourcePath
    )}&overwrite=true`,
    { method: "GET" }
  );

  if (!uploadResponse.ok) {
    throw new YandexDiskError(
      `Не удалось получить ссылку для загрузки «${fileName}» (HTTP ${uploadResponse.status})`,
      uploadResponse.status
    );
  }

  const payload = (await uploadResponse.json().catch(() => null)) as {
    href?: string;
  } | null;

  if (!payload?.href) {
    throw new YandexDiskError(
      `Яндекс Диск не вернул ссылку для загрузки «${fileName}».`
    );
  }
  const uploadUrl = new URL(payload.href);
  if (
    uploadUrl.protocol !== "https:" ||
    uploadUrl.username ||
    uploadUrl.password ||
    !["yandex.net", "yandex.ru", "yandex.com"].some(
      (host) =>
        uploadUrl.hostname === host || uploadUrl.hostname.endsWith(`.${host}`)
    )
  )
    throw new YandexDiskError("Получена небезопасная ссылка загрузки.");

  let fileResponse: Response;

  try {
    fileResponse = await fetch(payload.href, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: content,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
      redirect: "error",
    });
  } catch (error) {
    throw new YandexDiskError(describeDiskError(error));
  }

  if (!fileResponse.ok) {
    throw new YandexDiskError(
      `Не удалось загрузить «${fileName}» на Яндекс Диск (${fileResponse.status}).`,
      fileResponse.status
    );
  }

  return toDisplayPath([...segments, fileName]);
}

export async function syncKnowledgeCardToDisk(
  card: KnowledgeCard,
  allCards: KnowledgeCard[],
  customTypes: CardTypeDefinition[] = []
): Promise<DiskSyncInfo> {
  if (!isCardApproved(card))
    throw new YandexDiskError("Выгрузка черновика запрещена.", 409);
  const previous = card.diskSync ?? createPendingDiskSync();
  const attemptedAt = new Date().toISOString();
  const segments = getCardDiskFolderSegments(card);
  const markdown = buildKnowledgeCardMarkdown(card, customTypes);
  const summary = buildKnowledgeCardsSummaryCsv(card, allCards, customTypes);
  const fileName = getKnowledgeCardBackupFileName(card, customTypes);
  const snapshotAt = snapshotVersion(
    allCards
      .map(getApprovedVersion)
      .filter((item): item is KnowledgeCard => item !== null)
  );
  const summaryName = `${versionStamp(snapshotAt)}--${DISK_CARD_SUMMARY_FILE.replace(/\.csv$/, `--${contentHash(summary)}.csv`)}`;
  let fileUploaded = false;
  const pointerPaths: string[] = [];

  try {
    const token = getToken();
    await uploadFile(
      token,
      [],
      "_КАК_ЧИТАТЬ_РЕЗЕРВ.md",
      DISK_RESTORE_GUIDE,
      "text/markdown; charset=utf-8"
    );

    const filePath = await uploadFile(
      token,
      segments,
      fileName,
      markdown,
      "text/markdown; charset=utf-8"
    );
    fileUploaded = true;
    if (card.type === "project" && card.isJoint) {
      for (const universityId of card.participantUniversityIds) {
        const pointerSegments = [
          "01_Вузы_резиденты",
          getUniversityName(universityId),
          "Продукты_и_проекты",
        ];
        const target = toDisplayPath([...segments, fileName]);
        pointerPaths.push(
          await uploadFile(
            token,
            pointerSegments,
            `${versionStamp(card.updatedAt)}--${sanitizeFileName(card.id)}.link.md`,
            `# ${card.title}\n\nУказатель на единую совместную карточку.\n\n- Согласованная версия (UTC): ${card.updatedAt}\n- ID: ${card.id}\n- Вузы: ${card.participantUniversityIds.map(getUniversityName).join(", ")}\n- Файл на Диске: ${target}\n\n[Открыть единую карточку](../../../${target.split("/").map(encodeURIComponent).join("/")})\n`,
            "text/markdown; charset=utf-8"
          )
        );
      }
    }
    const summaryPath = await uploadFile(
      token,
      segments,
      summaryName,
      summary,
      "text/csv; charset=utf-8"
    );

    return {
      status: "synced",
      lastAttemptAt: attemptedAt,
      lastSyncedAt: attemptedAt,
      message: null,
      folderPath: toDisplayPath(segments),
      filePath,
      summaryPath,
      sourceUpdatedAt: card.updatedAt,
      fileUploaded: true,
      summaryUploaded: true,
      pointerPaths,
    };
  } catch (error) {
    return {
      status: "failed",
      lastAttemptAt: attemptedAt,
      lastSyncedAt: previous.lastSyncedAt ?? null,
      message: describeDiskError(error),
      folderPath: toDisplayPath(segments),
      filePath: toDisplayPath([...segments, fileName]),
      summaryPath: toDisplayPath([...segments, summaryName]),
      sourceUpdatedAt: card.updatedAt,
      fileUploaded,
      summaryUploaded: false,
      pointerPaths,
    };
  }
}

export async function syncArticleToDisk(
  article: ReadyArticle,
  allArticles: ReadyArticle[]
): Promise<DiskSyncInfo> {
  if (!isApprovedArticle(article))
    throw new YandexDiskError(
      "Выгрузка неподтверждённой статьи запрещена.",
      409
    );
  const previous = article.diskSync ?? createPendingDiskSync();
  const attemptedAt = new Date().toISOString();
  const segments = getArticleDiskFolderSegments(article);
  const markdown = buildArticleMarkdown(article);
  const summary = buildArticlesSummaryCsv(article, allArticles);
  const fileName = getArticleBackupFileName(article);
  const summaryName = `${versionStamp(snapshotVersion(allArticles.filter(isApprovedArticle)))}--${DISK_ARTICLE_SUMMARY_FILE.replace(/\.csv$/, `--${contentHash(summary)}.csv`)}`;
  let fileUploaded = false;

  try {
    const token = getToken();
    await uploadFile(
      token,
      [],
      "_КАК_ЧИТАТЬ_РЕЗЕРВ.md",
      DISK_RESTORE_GUIDE,
      "text/markdown; charset=utf-8"
    );

    const filePath = await uploadFile(
      token,
      segments,
      fileName,
      markdown,
      "text/markdown; charset=utf-8"
    );
    fileUploaded = true;
    const summaryPath = await uploadFile(
      token,
      segments,
      summaryName,
      summary,
      "text/csv; charset=utf-8"
    );

    return {
      status: "synced",
      lastAttemptAt: attemptedAt,
      lastSyncedAt: attemptedAt,
      message: null,
      folderPath: toDisplayPath(segments),
      filePath,
      summaryPath,
      sourceUpdatedAt: article.updatedAt,
      sourceRevisionId: article.approval!.revisionId,
      fileUploaded: true,
      summaryUploaded: true,
    };
  } catch (error) {
    return {
      status: "failed",
      lastAttemptAt: attemptedAt,
      lastSyncedAt: previous.lastSyncedAt ?? null,
      message: describeDiskError(error),
      folderPath: toDisplayPath(segments),
      filePath: toDisplayPath([...segments, fileName]),
      summaryPath: toDisplayPath([...segments, summaryName]),
      sourceUpdatedAt: article.updatedAt,
      sourceRevisionId: article.approval!.revisionId,
      fileUploaded,
      summaryUploaded: false,
    };
  }
}
