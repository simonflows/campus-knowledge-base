import { createHash } from "node:crypto";
import { isApprovedArticle, type ReadyArticle } from "./articles";
import {
  createPendingDiskSync,
  diskRegistrySequence,
  lastSuccessfulDiskExport,
  type DiskRegistry,
  type DiskRegistryContent,
  type DiskSyncInfo,
} from "./disk-sync";
import {
  folderIds,
  getCardTypeLabel,
  getFolderPath,
  getUniversityName,
  getApprovedVersion,
  isCardApproved,
  knowledgeTree,
  type CardTypeDefinition,
  type KnowledgeCard,
  type KnowledgeFolderNode,
} from "./knowledge";
import { getCardVersionId } from "./knowledge-versions";

const DISK_API_BASE = "https://cloud-api.yandex.net/v1/disk";
export function diskAttemptDeadline(): AbortSignal {
  return AbortSignal.timeout(30_000);
}

export const DISK_CARD_SUMMARY_FILE = "_Сводная_таблица_карточек.csv";
export const DISK_ARTICLE_SUMMARY_FILE = "_Сводная_таблица_статей.csv";
export const DISK_RESTORE_GUIDE = `# Как читать резервную копию

На Диске откройте папку с материалами, затем _Подтверждённые_сводки и выберите «Карточки» или «Статьи». Откройте подтверждение с наибольшим номером в начале имени файла. В нём есть ссылка на сводную CSV. В CSV найдите нужный материал и путь к его MD. Сортируйте подтверждения по имени файла: дата загрузки на Диск не учитывает задержку старой попытки.

Строка «Ожидает выгрузки» указывает на неполный результат. Для такого материала можно открыть последнюю полностью выгруженную редакцию из предыдущего подтверждения. CSV только с заголовком означает, что в папке больше нет действующих материалов. Прежние редакции сохраняются. Если приложение недоступно, Диск показывает те подтверждения, которые успели разместить.

Совместные проекты хранятся едиными MD в 02_Совместные_проекты. Их действующие редакции перечислены в подтверждённых сводках этого раздела. В папках вузов файлы .link.md указывают ID, версию и путь к одной конкретной редакции. Повтор после ошибки сохраняет файлы той же редакции. Предыдущие версии доступны в архиве.

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
  const root = process.env.YANDEX_DISK_ROOT_MODE === "app" ? "app:" : "disk:";
  return `${root}/${segments.join("/")}`;
}

export function diskRegistryId(kind: "cards" | "articles", segments: string[]): string {
  const scope = createHash("sha256").update(toResourcePath(segments)).digest("hex");
  return `disk-registry:${kind}:${scope}`;
}

export const EMPTY_DISK_REGISTRY_FINGERPRINT = createHash("sha256").update("[]").digest("hex");

export function diskRegistryFolder(registry: DiskRegistry): { kind: DiskRegistryContent; segments: string[]; summaryName: string } | null {
  const kind = registry.id.startsWith("disk-registry:cards:") ? "cards"
    : registry.id.startsWith("disk-registry:articles:") ? "articles" : null;
  const parts = registry.summaryPath.split("/");
  const summaryName = parts.pop();
  if (!kind || !summaryName?.endsWith(".csv") || !parts.length ||
      parts.some(part => !part || part === "." || part === ".." || part.includes("\\")) ||
      diskRegistryId(kind, parts) !== registry.id) return null;
  return { kind, segments: parts, summaryName };
}

export function diskRegistryReceipt(registry: DiskRegistry) {
  const folder = diskRegistryFolder(registry);
  if (!folder) throw new Error("Некорректный путь сводки Диска.");
  const number = String(diskRegistrySequence(registry)).padStart(16, "0");
  const content = [
    "# Подтверждённая сводка",
    "",
    `- Номер: ${number}`,
    `- Подтверждена (UTC): ${registry.confirmedAt}`,
    `- Ожидают выгрузки: ${registry.pendingRows ?? "см. сводную таблицу"}`,
    "",
    `[Открыть сводную CSV](../../${encodeURIComponent(folder.summaryName)})`,
    "",
  ].join("\n");
  return {
    segments: [...folder.segments, "_Подтверждённые_сводки", folder.kind === "cards" ? "Карточки" : "Статьи"],
    fileName: `${number}--${sanitizeFileName(registry.versionId)}--${contentHash(content)}.md`,
    content,
  };
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

  if (card.sources?.length) {
    lines.push("## Источники", "", ...card.sources.map(source =>
      `- ${source.title}: ${source.url}${source.publishedAt ? `; опубликовано: ${source.publishedAt}` : ""}${source.scope ? `; область: ${source.scope}` : ""}`
    ), "");
  }
  if (card.verifiedFacts?.length) {
    lines.push("## Проверенные факты", "", ...card.verifiedFacts.map(fact =>
      `- ${fact.label}: ${fact.value} ${fact.unit}; год: ${fact.year}; ${fact.kind === "plan" ? "план" : "факт"}; область: ${fact.scope}; документ: ${fact.evidenceUrl}`
    ), "");
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

function matchingDiskBackup(
  item: { updatedAt: string; diskSync?: DiskSyncInfo },
  revisionId?: string
) {
  const complete = lastSuccessfulDiskExport(item.diskSync);
  if (
    complete?.sourceUpdatedAt === item.updatedAt &&
    complete.sourceRevisionId === revisionId
  )
    return { filePath: complete.filePath, complete: true };

  const sync = item.diskSync;
  if (
    sync?.sourceUpdatedAt === item.updatedAt &&
    sync.sourceRevisionId === revisionId
  )
    return {
      filePath: sync.fileUploaded ? sync.filePath : undefined,
      complete: sync.status === "synced",
    };

  return { filePath: undefined, complete: false };
}

function approvedCardsInFolder(card: KnowledgeCard, allCards: KnowledgeCard[]) {
  const folder = getCardDiskFolderSegments(card).join("/");
  return allCards.map(getApprovedVersion)
    .filter((item): item is KnowledgeCard => item !== null && getCardDiskFolderSegments(item).join("/") === folder)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function approvedArticlesInFolder(article: ReadyArticle, allArticles: ReadyArticle[]) {
  return allArticles
    .filter(item => isApprovedArticle(item) && item.universityId === article.universityId)
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function countCardSummaryPending(scope: KnowledgeCard, cards: KnowledgeCard[], uploadedId: string): number {
  return approvedCardsInFolder(scope, cards).filter(item => item.id !== uploadedId && !matchingDiskBackup(item).complete).length;
}

export function countArticleSummaryPending(scope: ReadyArticle, articles: ReadyArticle[], uploadedId: string): number {
  return approvedArticlesInFolder(scope, articles)
    .filter(item => item.id !== uploadedId && !matchingDiskBackup(item, item.approval!.revisionId).complete).length;
}

// Track exported substance and row completeness. Comments and freshness-only writes
// can advance updatedAt without changing the published card.
export function cardRegistryFingerprint(
  scope: KnowledgeCard, allCards: KnowledgeCard[], customTypes: CardTypeDefinition[], uploadedId: string
): string {
  const rows = approvedCardsInFolder(scope, allCards).map(item => {
    const definition = item.type === "custom" ? customTypes.find(type => type.id === item.customTypeId) : undefined;
    return [
      item.id,
      getCardVersionId(item),
      definition?.name,
      definition?.fields.map(({ id, name, type, required, options }) => [id, name, type, required, options]),
      item.id === uploadedId || matchingDiskBackup(item).complete,
    ];
  });
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function articleRegistryFingerprint(scope: ReadyArticle, articles: ReadyArticle[], uploadedId: string): string {
  const rows = approvedArticlesInFolder(scope, articles).map(item => [
    item.id, item.updatedAt, item.approval!.revisionId, contentHash(buildArticleMarkdown(item)),
    item.id === uploadedId || matchingDiskBackup(item, item.approval!.revisionId).complete,
  ]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

const articleSummaryColumns = [
  "ID", "Название", "Вуз", "Проект", "Тема", "Карточки-источники", "Обновлено", "Согласованная редакция",
  "Путь к неизменяемому MD", "Согласованный снимок реестра (UTC)", "Состояние MD", "Версии источников",
];

const cardSummaryColumns = [
  "ID", "Название", "Тип", "Папка", "Владельцы", "Обновлено (UTC)",
  "Путь к неизменяемому MD", "Согласованный снимок реестра (UTC)", "Состояние MD",
];

export function buildArticlesSummaryCsv(
  article: ReadyArticle,
  allArticles: ReadyArticle[]
): string {
  const approved = approvedArticlesInFolder(article, allArticles);
  const snapshotAt = snapshotVersion(approved);
  const rows: Array<Array<string | number | null | undefined>> = [
    articleSummaryColumns,
    ...approved.map((item) => {
        const revisionId = item.approval!.revisionId;
        const isTarget =
          item.id === article.id &&
          item.updatedAt === article.updatedAt &&
          revisionId === article.approval?.revisionId;
        const backup = matchingDiskBackup(item, revisionId);
        return [
          item.id,
          item.title,
          getUniversityName(item.universityId),
          item.projectTitle,
          item.topic,
          item.sourceCardTitles.join(", "),
          item.updatedAt,
          revisionId,
          (!isTarget && backup.filePath) ||
            toDisplayPath([
              ...getArticleDiskFolderSegments(item),
              getArticleBackupFileName(item),
            ]),
          snapshotAt,
          isTarget || backup.complete ? "Выгружена" : "Ожидает выгрузки",
          item.sourceCardIds.map((cardId) => {
            const source = item.sourceVersions?.find((ref) => ref.cardId === cardId);
            return source ? `${cardId}@${source.versionId}` : `${cardId}: версия не зафиксирована`;
          }).join(", "),
        ];
      }),
  ];

  return buildCsv(rows);
}

export function buildKnowledgeCardsSummaryCsv(
  card: KnowledgeCard,
  allCards: KnowledgeCard[],
  customTypes: CardTypeDefinition[] = []
): string {
  const approved = approvedCardsInFolder(card, allCards);
  const snapshotAt = snapshotVersion(approved);
  const rows: Array<Array<string | number | null | undefined>> = [
    cardSummaryColumns,
    ...approved.map((item) => {
        const segments = getCardDiskFolderSegments(item);
        const isTarget = item.id === card.id && item.updatedAt === card.updatedAt;
        const backup = matchingDiskBackup(item);
        return [
          item.id,
          item.title,
          item.type,
          segments.join(" / "),
          item.owners.join(", "),
          item.updatedAt,
          (!isTarget && backup.filePath) ||
            toDisplayPath([
              ...segments,
              getKnowledgeCardBackupFileName(item, customTypes),
            ]),
          snapshotAt,
          isTarget || backup.complete ? "Выгружена" : "Ожидает выгрузки",
        ];
      }),
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
      ? article.sourceCardTitles.map((title, index) => {
        const cardId = article.sourceCardIds[index];
        const pinned = article.sourceVersions?.find((source) => source.cardId === cardId);
        if (!pinned) return `- ${title}`;
        const path = `/knowledge?card=${encodeURIComponent(cardId)}&version=${encodeURIComponent(pinned.versionId)}`;
        const origin = (process.env.CAMPUS_PUBLIC_ORIGIN ?? "").replace(/\/$/, "");
        return `- ${title} — [точная версия](${origin}${path})`;
      }).join("\n")
      : "Источники не указаны.",
    ""
  );

  return `${lines.join("\n").trim()}\n`;
}

function describeDiskError(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError")
    return "Истекло время выгрузки на Яндекс Диск. Попытку можно повторить.";
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
  signal: AbortSignal,
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
      signal,
      cache: "no-store",
    });
  } catch (error) {
    throw new YandexDiskError(describeDiskError(error));
  }
}

async function ensureFolder(
  signal: AbortSignal,
  token: string,
  segments: string[]
): Promise<void> {
  const folderSegments: string[] = [];

  for (const segment of segments) {
    folderSegments.push(segment);
    await ensureDirectory(signal, token, folderSegments);
  }
}

async function ensureDirectory(signal: AbortSignal, token: string, segments: string[]) {
  const current = toResourcePath(segments);
  const response = await diskRequest(
    signal, token, `${DISK_API_BASE}/resources?path=${encodeURIComponent(current)}`, { method: "PUT" },
  );
  if (!response.ok && response.status !== 409) {
    throw new YandexDiskError(`Не удалось создать папку «${current}» (HTTP ${response.status})`, response.status);
  }
}

async function uploadFile(
  signal: AbortSignal,
  token: string,
  segments: string[],
  fileName: string,
  content: string,
  contentType: string
): Promise<string> {
  signal.throwIfAborted();
  await ensureFolder(signal, token, segments);

  const resourcePath = toResourcePath([...segments, fileName]);
  const uploadResponse = await diskRequest(
    signal,
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
      signal,
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

const treePreparations = new Map<string, Promise<void>>();
const readyTrees = new Set<string>();

export function isDiskBackupTreeReady(): boolean {
  return readyTrees.has(toResourcePath([]));
}

export function ensureDiskBackupTree(signal: AbortSignal = diskAttemptDeadline()): Promise<void> {
  const root = toResourcePath([]);
  const prepared = treePreparations.get(root);
  if (prepared) return prepared;

  const prepare = async () => {
    const token = getToken();
    let layer: { node: KnowledgeFolderNode; segments: string[] }[] =
      knowledgeTree.map(node => ({ node, segments: [node.name] }));
    while (layer.length) {
      for (let offset = 0; offset < layer.length; offset += 4) {
        signal.throwIfAborted();
        const results = await Promise.allSettled(layer.slice(offset, offset + 4)
          .map(({ segments }) => ensureDirectory(signal, token, segments)));
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
      }
      layer = layer.flatMap(({ node, segments }) =>
        (node.children ?? []).map(child => ({ node: child, segments: [...segments, child.name] })));
    }
    await uploadFile(signal, token, [], "_КАК_ЧИТАТЬ_РЕЗЕРВ.md", DISK_RESTORE_GUIDE, "text/markdown; charset=utf-8");
    readyTrees.add(root);
  };

  const attempt = prepare().catch(error => {
    treePreparations.delete(root);
    throw error;
  });
  treePreparations.set(root, attempt);
  return attempt;
}

export function uploadDiskRegistryReceipt(registry: DiskRegistry, signal: AbortSignal) {
  const { segments, fileName, content } = diskRegistryReceipt(registry);
  return uploadFile(signal, getToken(), segments, fileName, content, "text/markdown; charset=utf-8");
}

export async function verifyLegacyDiskSummary(registry: DiskRegistry, signal: AbortSignal): Promise<boolean> {
  const folder = diskRegistryFolder(registry);
  const hash = folder?.summaryName.match(/--([0-9a-f]{20})\.csv$/)?.[1];
  if (!folder || !hash) return false;
  const path = toResourcePath([...folder.segments, folder.summaryName]);
  const response = await diskRequest(signal, getToken(),
    `${DISK_API_BASE}/resources/download?path=${encodeURIComponent(path)}`, { redirect: "error" });
  if (response.status === 404) return false;
  if (!response.ok) throw new YandexDiskError("Не удалось проверить файл сводки.", response.status);
  const payload = await response.json() as { href?: unknown };
  if (typeof payload.href !== "string") throw new YandexDiskError("Диск не вернул ссылку для проверки сводки.");
  const url = new URL(payload.href);
  const hosts = ["disk.yandex.net", "disk.yandex.ru"];
  if (url.protocol !== "https:" || url.port || url.username || url.password ||
      !hosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new YandexDiskError("Адрес проверки сводки не принадлежит Диску.");
  }
  const file = await fetch(url, { signal, redirect: "error", cache: "no-store" });
  if (file.status === 404) return false;
  if (!file.ok || !file.body) throw new YandexDiskError("Файл сводки недоступен для проверки.", file.status);
  const digest = createHash("sha256");
  const reader = file.body.getReader();
  let bytes = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 8_000_000) {
      await reader.cancel();
      return false;
    }
    digest.update(value);
  }
  return digest.digest("hex").slice(0, 20) === hash;
}

export function buildEmptyDiskSummary(kind: DiskRegistryContent) {
  return buildCsv([kind === "cards" ? cardSummaryColumns : articleSummaryColumns]);
}

export function uploadEmptyDiskSummary(registry: DiskRegistry, signal: AbortSignal) {
  const folder = diskRegistryFolder(registry);
  if (!folder) throw new Error("Некорректный путь сводки Диска.");
  const content = buildEmptyDiskSummary(folder.kind);
  const prefix = folder.kind === "cards" ? DISK_CARD_SUMMARY_FILE : DISK_ARTICLE_SUMMARY_FILE;
  const fileName = `${versionStamp(registry.confirmedAt)}--${prefix.replace(/\.csv$/, `--${contentHash(content)}.csv`)}`;
  return uploadFile(signal, getToken(), folder.segments, fileName, content, "text/csv; charset=utf-8");
}

export async function syncKnowledgeCardToDisk(
  card: KnowledgeCard,
  allCards: KnowledgeCard[],
  customTypes: CardTypeDefinition[] = [],
  signal: AbortSignal = diskAttemptDeadline()
): Promise<DiskSyncInfo> {
  if (!isCardApproved(card))
    throw new YandexDiskError("Выгрузка черновика запрещена.", 409);
  const previous = card.diskSync ?? createPendingDiskSync();
  const attemptedAt = new Date().toISOString();
  const segments = getCardDiskFolderSegments(card);
  const markdown = buildKnowledgeCardMarkdown(card, customTypes);
  const summary = buildKnowledgeCardsSummaryCsv(card, allCards, customTypes);
  const fileName = getKnowledgeCardBackupFileName(card, customTypes);
  const snapshotAt = snapshotVersion(approvedCardsInFolder(card, allCards));
  const summaryName = `${versionStamp(snapshotAt)}--${DISK_CARD_SUMMARY_FILE.replace(/\.csv$/, `--${contentHash(summary)}.csv`)}`;
  let fileUploaded = false;
  const pointerPaths: string[] = [];

  try {
    const token = getToken();
    await uploadFile(
      signal,
      token,
      [],
      "_КАК_ЧИТАТЬ_РЕЗЕРВ.md",
      DISK_RESTORE_GUIDE,
      "text/markdown; charset=utf-8"
    );

    const filePath = await uploadFile(
      signal,
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
        const pointer = `# ${card.title}\n\nУказатель на единую совместную карточку.\n\n- Согласованная версия (UTC): ${card.updatedAt}\n- ID: ${card.id}\n- Вузы: ${card.participantUniversityIds.map(getUniversityName).join(", ")}\n- Файл на Диске: ${target}\n\n[Открыть единую карточку](../../../${target.split("/").map(encodeURIComponent).join("/")})\n`;
        pointerPaths.push(
          await uploadFile(
            signal,
            token,
            pointerSegments,
            `${versionStamp(card.updatedAt)}--${sanitizeFileName(card.id)}--${contentHash(pointer)}.link.md`,
            pointer,
            "text/markdown; charset=utf-8"
          )
        );
      }
    }
    const summaryPath = await uploadFile(
      signal,
      token,
      segments,
      summaryName,
      summary,
      "text/csv; charset=utf-8"
    );

    return {
      status: "synced",
      lastAttemptAt: attemptedAt,
      lastSyncedAt: new Date().toISOString(),
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
      ...createPendingDiskSync(previous),
      status: "failed",
      lastAttemptAt: attemptedAt,
      message: describeDiskError(error),
      folderPath: toDisplayPath(segments),
      filePath: toDisplayPath([...segments, fileName]),
      summaryPath: toDisplayPath([...segments, summaryName]),
      sourceUpdatedAt: card.updatedAt,
      fileUploaded:
        fileUploaded ||
        (previous.filePath === toDisplayPath([...segments, fileName]) &&
          !!previous.fileUploaded),
      summaryUploaded:
        previous.summaryPath === toDisplayPath([...segments, summaryName]) &&
        !!previous.summaryUploaded,
      pointerPaths:
        previous.filePath === toDisplayPath([...segments, fileName])
          ? [...new Set([...(previous.pointerPaths ?? []), ...pointerPaths])]
          : pointerPaths,
    };
  }
}

export async function syncArticleToDisk(
  article: ReadyArticle,
  allArticles: ReadyArticle[],
  signal: AbortSignal = diskAttemptDeadline()
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
  const summaryName = `${versionStamp(snapshotVersion(approvedArticlesInFolder(article, allArticles)))}--${DISK_ARTICLE_SUMMARY_FILE.replace(/\.csv$/, `--${contentHash(summary)}.csv`)}`;
  let fileUploaded = false;

  try {
    const token = getToken();
    await uploadFile(
      signal,
      token,
      [],
      "_КАК_ЧИТАТЬ_РЕЗЕРВ.md",
      DISK_RESTORE_GUIDE,
      "text/markdown; charset=utf-8"
    );

    const filePath = await uploadFile(
      signal,
      token,
      segments,
      fileName,
      markdown,
      "text/markdown; charset=utf-8"
    );
    fileUploaded = true;
    const summaryPath = await uploadFile(
      signal,
      token,
      segments,
      summaryName,
      summary,
      "text/csv; charset=utf-8"
    );

    return {
      status: "synced",
      lastAttemptAt: attemptedAt,
      lastSyncedAt: new Date().toISOString(),
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
      ...createPendingDiskSync(previous),
      status: "failed",
      lastAttemptAt: attemptedAt,
      message: describeDiskError(error),
      folderPath: toDisplayPath(segments),
      filePath: toDisplayPath([...segments, fileName]),
      summaryPath: toDisplayPath([...segments, summaryName]),
      sourceUpdatedAt: article.updatedAt,
      sourceRevisionId: article.approval!.revisionId,
      fileUploaded:
        fileUploaded ||
        (previous.filePath === toDisplayPath([...segments, fileName]) &&
          !!previous.fileUploaded),
      summaryUploaded:
        previous.summaryPath === toDisplayPath([...segments, summaryName]) &&
        !!previous.summaryUploaded,
    };
  }
}
