import { z } from "zod";
import { articleBasisReference, type ReadyArticle } from "./articles";
import { demoAccounts, getDemoAccount, type SessionUser } from "./auth";
import {
  approvedDemoCards,
  demoArticles,
  demoUser,
  nextDemoTimestamp,
  type BrowserDemoState,
  type DemoEditorialRow,
} from "./browser-demo";
import {
  demoError,
  type DemoCall,
  type DemoHandler,
} from "./browser-demo-http";
import { demoCardVersionId } from "./browser-demo-version";
import {
  canDeleteEditorial,
  canReadEditorial,
  canWriteEditorial,
  createEditorialSchema,
  deleteEditorialSchema,
  editorialMutationSchema,
  EditorialError,
  editorialText,
  validateEditorialAction,
  type EditorialContent,
  type EditorialDocument,
  type EditorialEvent,
  type EditorialRevision,
} from "./editorial";
import {
  buildDeterministicArticleDraft,
  buildNoDataDraft,
  getBasisChunks,
  isBasisOnlyArticleRequest,
  selectRelevantCards,
  selectUniversityMetricCards,
} from "./editor";
import { checkEditorialEvidence } from "./editorial-evidence";
import { checkFactText } from "./fact-check";
import { isReviewOverdue } from "./knowledge-freshness";
import { sourceVersionSchema } from "./source-references";
import { saveArticleInputSchema } from "./validation/articles";
import { articleBasisRequestSchema } from "./validation/editor-basis";

const generationSchema = z
  .object({
    query: z.string().trim().max(2000).default(""),
    basis: articleBasisRequestSchema.optional(),
  })
  .refine(({ query, basis }) => query.length >= 10 || Boolean(basis));
const revisionFields = {
  revisionId: z.string().max(100),
  version: z.number().int().positive(),
};
const readinessInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("check"), ...revisionFields }),
  z.object({
    action: z.literal("review-sources"),
    ...revisionFields,
    sourceVersions: z.array(sourceVersionSchema).min(1).max(20),
    comment: z.string().trim().min(1).max(1000),
  }),
]);
const assistInput = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("rewrite"),
    documentId: z.string(),
    ...revisionFields,
    chunkId: z.string().optional(),
    start: z.number().int().min(0),
    end: z.number().int().min(1).max(4000),
  }),
  z.object({
    action: z.literal("variant"),
    documentId: z.string(),
    ...revisionFields,
    channel: z.string().trim().min(1).max(100),
  }),
]);

export function demoEditorialRows(state: BrowserDemoState): DemoEditorialRow[] {
  const stored = state.editorialRows ?? [];
  const omitted = new Set([
    ...(state.removedDocumentIds ?? []),
    ...stored.map(({ document }) => document.id),
  ]);
  return [
    ...stored,
    ...state.documents
      .filter(({ id }) => !omitted.has(id))
      .map((doc) => {
        const ownerName =
          getDemoAccount(doc.author)?.name ?? "Учебный сотрудник";
        const revision: EditorialRevision = {
          id: doc.status === "approved" ? doc.updatedAt : `${doc.id}-v1`,
          documentId: doc.id,
          number: 1,
          content: pinSources(state, doc.content),
          actorId: doc.author,
          actorName: ownerName,
          createdAt: doc.createdAt,
        };
        const document: EditorialDocument = {
          ...doc,
          ownerId: doc.author,
          ownerName,
          originalId: doc.id,
          channel: "Оригинал",
          version: 1,
          revisionId: revision.id,
          submittedRevisionId: doc.status === "submitted" ? revision.id : null,
          approvedRevisionId: doc.status === "approved" ? revision.id : null,
          events: [],
          content: revision.content,
        };
        return { document, revisions: [revision] };
      }),
  ];
}

function pinSources(
  state: BrowserDemoState,
  content: EditorialContent
): EditorialContent {
  const approved = new Map(
    approvedDemoCards(state).map((card) => [card.id, card])
  );
  const existing = new Map(
    content.sourceVersions?.map(({ cardId, versionId }) => [cardId, versionId])
  );
  return {
    ...content,
    sourceCardTitles: content.sourceCardIds.map(
      (id, index) =>
        approved.get(id)?.title ?? content.sourceCardTitles[index] ?? id
    ),
    sourceVersions: [...new Set(content.sourceCardIds)].flatMap((cardId) => {
      const card = approved.get(cardId);
      const versionId =
        existing.get(cardId) ?? (card && demoCardVersionId(card));
      return versionId ? [{ cardId, versionId }] : [];
    }),
  };
}

function reviewOptions(document: EditorialDocument) {
  return demoAccounts
    .filter(
      (account) =>
        account.id !== document.ownerId &&
        (account.role === "admin" ||
          (account.role === "university_owner" &&
            account.universityId === document.content.universityId))
    )
    .map(({ id, name, role }) => ({ id, name, role }));
}

function upsert(state: BrowserDemoState, row: DemoEditorialRow) {
  return {
    ...state,
    editorialRows: [
      row,
      ...(state.editorialRows ?? []).filter(
        ({ document }) => document.id !== row.document.id
      ),
    ],
  };
}

function makeRevision(
  id: string,
  number: number,
  content: EditorialContent,
  user: SessionUser,
  at: string
): EditorialRevision {
  return {
    id: crypto.randomUUID(),
    documentId: id,
    number,
    content,
    actorId: user.id,
    actorName: user.name,
    createdAt: at,
  };
}

function event(
  user: SessionUser,
  action: EditorialEvent["action"],
  revisionId: string,
  at: string,
  comment = ""
): EditorialEvent {
  return {
    id: crypto.randomUUID(),
    actorId: user.id,
    actorName: user.name,
    action,
    revisionId,
    at,
    comment,
  };
}

function createDraft(
  call: DemoCall,
  state: BrowserDemoState,
  user: SessionUser
) {
  const input = createEditorialSchema.parse(call.body());
  if (
    input.originalId &&
    !demoEditorialRows(state).some(
      ({ document }) =>
        document.originalId === input.originalId &&
        canReadEditorial(user, document)
    )
  )
    return demoError("Учебный оригинал не найден.", 404);
  const id = `demo-doc-${crypto.randomUUID()}`;
  const now = nextDemoTimestamp();
  const content = pinSources(state, input.content);
  const revision = makeRevision(id, 1, content, user, now);
  const document: EditorialDocument = {
    id,
    ownerId: user.id,
    ownerName: user.name,
    originalId: input.originalId ?? id,
    channel: input.channel,
    version: 1,
    revisionId: revision.id,
    submittedRevisionId: null,
    approvedRevisionId: null,
    status: "draft",
    content,
    createdAt: now,
    updatedAt: now,
    events: [event(user, "created", revision.id, now)],
    legacyArticleId: input.legacyArticleId,
  };
  call.save(upsert(state, { document, revisions: [revision] }));
  return Response.json(document, { status: 201 });
}

function draftSnapshot(
  call: DemoCall,
  state: BrowserDemoState,
  row: DemoEditorialRow
) {
  const { document } = row;
  const cards = approvedDemoCards(state);
  const pins = new Map(
    document.content.sourceVersions?.map(({ cardId, versionId }) => [
      cardId,
      versionId,
    ])
  );
  for (const review of row.readiness?.reviews ?? [])
    pins.set(review.cardId, review.versionId);
  const sources = document.content.sourceCardIds.map((id) => ({
    id,
    current: cards.find((card) => card.id === id),
  }));
  const evidence = new Map(
    sources.flatMap(({ id, current }) => {
      if (!current) return [];
      const pin = pins.get(id);
      const snapshot =
        pin === demoCardVersionId(current)
          ? current
          : state.cardVersions?.find(
              (card) => card.id === id && demoCardVersionId(card) === pin
            );
      return snapshot ? [[id, snapshot] as const] : [];
    })
  );
  const unknownSources = sources
    .filter(({ id }) => !evidence.has(id))
    .map(({ id }) => id);
  const changedSources = sources.flatMap(({ id, current }) => {
    if (!current) return [];
    const currentVersionId = demoCardVersionId(current);
    const usedVersionId = pins.get(id) ?? null;
    return currentVersionId !== usedVersionId
      ? [{ cardId: id, currentVersionId, usedVersionId }]
      : [];
  });
  const checkedAt = row.readiness?.checkedAt ?? null;
  const result =
    checkedAt && unknownSources.length === 0
      ? checkEditorialEvidence(editorialText(document.content), [
          ...evidence.values(),
        ])
      : null;
  const approval = demoArticles(state).find(
    (article) => article.id === document.id
  )?.approval;
  if (call.method === "POST") {
    const input = readinessInput.parse(call.body());
    if (
      document.version !== input.version ||
      document.revisionId !== input.revisionId
    )
      return demoError("Учебная редакция изменилась.", 409);
    const readiness = { ...row.readiness, revisionId: document.revisionId };
    if (input.action === "check") readiness.checkedAt = nextDemoTimestamp();
    else {
      if (
        input.sourceVersions.some(
          (source) =>
            !changedSources.some(
              (item) =>
                item.cardId === source.cardId &&
                item.currentVersionId === source.versionId
            )
        )
      )
        return demoError("Откройте актуальные учебные источники.", 409);
      delete readiness.checkedAt;
      readiness.reviews = [
        ...(readiness.reviews ?? []).filter(
          ({ cardId }) =>
            !input.sourceVersions.some((source) => source.cardId === cardId)
        ),
        ...input.sourceVersions.map((source) => ({
          ...source,
          comment: input.comment,
        })),
      ];
    }
    const next = upsert(state, { ...row, readiness });
    call.save(next);
    return draftSnapshot({ ...call, method: "GET" }, next, {
      ...row,
      readiness,
    });
  }
  return Response.json({
    documentId: document.id,
    revisionId: document.revisionId,
    version: document.version,
    revisionNumber:
      row.revisions.find(({ id }) => id === document.revisionId)?.number ?? 1,
    ready: false,
    reasons: [
      ...(!approval ? ["Точная редакция ещё не согласована."] : []),
      ...(result?.canPublish
        ? []
        : ["Нужна проверка текста и его источников."]),
      ...(unknownSources.length
        ? ["У части источников неизвестна или недоступна точная версия."]
        : []),
      ...(changedSources.length
        ? ["Учебные источники обновились: нужна ручная сверка."]
        : []),
      "Яндекс Диск недоступен в демо. Файл DOCX можно скачать на устройство.",
    ],
    changedSources,
    unknownSources,
    overdueSources: sources
      .filter(({ current }) =>
        isReviewOverdue(current?.freshness?.nextReviewAt)
      )
      .map(({ id }) => id),
    sourceVersions: document.content.sourceVersions ?? [],
    reviewedSourceVersions: (row.readiness?.reviews ?? []).map((review) => ({
      ...review,
      reviewedAt: document.updatedAt,
      reviewedBy: "Учебный сотрудник",
    })),
    approval: {
      status: document.status,
      ...(approval && {
        approvedAt: approval.approvedAt,
        approvedBy: approval.approvedBy,
      }),
    },
    check: {
      status: result
        ? result.canPublish
          ? "passed"
          : "attention"
        : checkedAt
          ? "stale"
          : "missing",
      checkedAt,
      summary: result?.summary ?? null,
      findings:
        result?.findings
          .filter(({ level }) => level !== "green")
          .slice(0, 30) ?? [],
    },
    disk: { status: "missing", syncedAt: null },
  });
}

function updateDraft(
  call: DemoCall,
  state: BrowserDemoState,
  row: DemoEditorialRow,
  user: SessionUser
) {
  const { document } = row;
  const input = editorialMutationSchema.parse(call.body());
  validateEditorialAction(user, document, input);
  const now = nextDemoTimestamp(document.updatedAt);
  let next: EditorialDocument = {
    ...document,
    version: document.version + 1,
    updatedAt: now,
  };
  let revisions = row.revisions;
  let readiness = row.readiness;
  let action: EditorialEvent["action"];
  if (input.action === "save" || input.action === "restore") {
    if (!["draft", "returned"].includes(document.status))
      return demoError(
        "Учебную редакцию нельзя изменить на согласовании.",
        409
      );
    const older =
      input.action === "restore"
        ? revisions.find(({ id }) => id === input.revisionId)
        : undefined;
    if (input.action === "restore" && !older)
      return demoError("Учебная редакция не найдена.", 404);
    const content = pinSources(
      state,
      input.action === "save" ? input.content : older!.content
    );
    const revision = makeRevision(
      document.id,
      Math.max(...revisions.map(({ number }) => number)) + 1,
      content,
      user,
      now
    );
    if (older) revision.restoredFrom = older.id;
    revisions = [...revisions, revision];
    next = { ...next, content, revisionId: revision.id };
    readiness = undefined;
    action = older ? "restored" : "saved";
  } else if (input.action === "submit") {
    const content = document.content;
    if (!["draft", "returned"].includes(document.status))
      return demoError("Документ уже на согласовании.", 409);
    if (
      !content.title.trim() ||
      !content.lead.trim() ||
      !content.sections.some((section) =>
        section.chunks.some(({ content }) => content.trim())
      ) ||
      !content.sourceCardIds.length
    )
      return demoError(
        "Добавьте заголовок, лид, основной текст и учебный источник.",
        422
      );
    const reviewers = reviewOptions(document);
    const reviewer =
      reviewers.find((option) => option.id === input.reviewerId) ??
      (!input.reviewerId
        ? reviewers.find(({ role }) => role === "admin")
        : undefined);
    if (!reviewer)
      return demoError(
        "Назначьте другого учебного сотрудника для согласования.",
        422
      );
    next = {
      ...next,
      status: "submitted",
      submittedRevisionId: document.revisionId,
      submittedOnce: true,
      reviewerId: reviewer.id,
      reviewerName: reviewer.name,
    };
    action = "submitted";
  } else if (input.action === "approve") {
    const pins = new Map(
      document.content.sourceVersions?.map(({ cardId, versionId }) => [
        cardId,
        versionId,
      ])
    );
    const approved = approvedDemoCards(state);
    const sources = approved.filter(
      (card) => pins.get(card.id) === demoCardVersionId(card)
    );
    if (
      !sources.length ||
      sources.length !== new Set(document.content.sourceCardIds).size
    )
      return demoError(
        "Сверьте актуальные версии учебных источников и отправьте редакцию снова.",
        409
      );
    const articleText = editorialText(document.content);
    if (
      checkFactText(articleText, sources).summary.red > 0 ||
      checkFactText(articleText, approved).findings.some(
        (finding) => finding.level === "red" && finding.sourceCardId
      )
    )
      return demoError(
        "Текст расходится с учебными карточками. Исправьте красные замечания.",
        422
      );
    next = {
      ...next,
      status: "approved",
      approvedRevisionId: document.revisionId,
    };
    action = "approved";
  } else if (input.action === "return") {
    next = { ...next, status: "returned", submittedRevisionId: null };
    action = "returned";
  } else {
    action = "commented";
  }
  next.events = [
    ...next.events,
    event(
      user,
      action,
      next.revisionId,
      now,
      "comment" in input ? input.comment : ""
    ),
  ];
  const updated = upsert(state, { document: next, revisions, readiness });
  call.save(updated);
  return Response.json({
    document: next,
    publication:
      action === "approved"
        ? demoArticles(updated).find((article) => article.id === next.id)
        : null,
  });
}

async function downloadDraft(call: DemoCall, row: DemoEditorialRow) {
  const id = call.url.searchParams.get("revisionId") || row.document.revisionId;
  const revision = row.revisions.find((item) => item.id === id);
  if (!revision) return demoError("Учебная редакция не найдена.", 404);
  const { Document, Packer, Paragraph, HeadingLevel } = await import("docx");
  const { content } = revision;
  const children = [
    new Paragraph({
      text: content.title || "Без заголовка",
      heading: HeadingLevel.TITLE,
    }),
    new Paragraph("Демо-режим. Учебный материал."),
    new Paragraph(content.lead),
    ...content.sections.flatMap((section) => [
      new Paragraph({
        text: section.heading,
        heading:
          section.level === 3 ? HeadingLevel.HEADING_3 : HeadingLevel.HEADING_2,
      }),
      ...section.chunks.flatMap((chunk) =>
        chunk.content.split(/\n\n+/u).map((part) => new Paragraph(part))
      ),
    ]),
    new Paragraph({
      text: "Учебные источники",
      heading: HeadingLevel.HEADING_2,
    }),
    ...content.sourceCardTitles.map((title) => new Paragraph(title)),
  ];
  const file = await Packer.toBlob(new Document({ sections: [{ children }] }));
  return new Response(file, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="demo-${row.document.id}.docx"`,
    },
  });
}

function generateArticle(call: DemoCall, state: BrowserDemoState) {
  const { query, basis } = generationSchema.parse(call.body());
  const articles = demoArticles(state);
  const basisArticle = basis
    ? articles.find(
        (article) =>
          article.id === basis.articleId &&
          article.approval?.revisionId === basis.revisionId
      )
    : undefined;
  if (basis && !basisArticle)
    return demoError("Утверждённая версия учебной статьи недоступна.", 409);
  const cards = approvedDemoCards(state);
  const basisOnly = Boolean(basisArticle && isBasisOnlyArticleRequest(query));
  const draftQuery = basisOnly ? basisArticle!.title : query;
  const selected = basisOnly
    ? cards.filter((card) => basisArticle!.sourceCardIds.includes(card.id))
    : (selectUniversityMetricCards(query, cards) ??
      selectRelevantCards(cards, query).map(({ card }) => card));
  if (!selected.length)
    return Response.json(
      buildNoDataDraft({
        query,
        message: "В учебной базе нет сведений по этому запросу.",
      })
    );
  const chunks = getBasisChunks(basisArticle, basis?.chunkIds);
  if (basis && chunks.length !== basis.chunkIds.length)
    return demoError("Учебный блок не найден.", 404);
  const built = buildDeterministicArticleDraft({
    query: draftQuery,
    selectedCards: selected,
    matchedArticles: basisArticle ? [basisArticle] : [],
    referenceChunks: chunks,
  });
  const articleBasis = chunks.flatMap(
    (chunk) => articleBasisReference(chunk) ?? []
  );
  return Response.json({
    noData: false,
    noDataMessage: null,
    query,
    article: {
      ...built,
      query,
      articleBasis,
      sourceVersions: cards
        .filter((card) => built.sourceCardIds.includes(card.id))
        .map((card) => ({
          cardId: card.id,
          versionId: demoCardVersionId(card),
        })),
    },
    sources: selected.map((card) => ({
      id: card.id,
      title: card.title,
      type: card.type,
      description: card.referenceDescription,
    })),
    usedArticles: basisArticle
      ? [
          {
            id: basisArticle.id,
            title: basisArticle.title,
            blocks: articleBasis,
          },
        ]
      : [],
    providerMeta: {
      provider: "canonical",
      modelLabel: "Демо-имитация ИИ по учебным карточкам",
      latencyMs: 0,
      anonymized152FZ: false,
      fallbackReason: null,
    },
  });
}

function editorAssist(
  call: DemoCall,
  state: BrowserDemoState,
  user: SessionUser
) {
  const input = assistInput.parse(call.body());
  const row = demoEditorialRows(state).find(
    ({ document }) =>
      document.id === input.documentId && canWriteEditorial(user, document)
  );
  if (!row) return demoError("Учебный черновик не найден.", 404);
  const { content, revisionId, version } = row.document;
  if (input.revisionId !== revisionId || input.version !== version)
    return demoError("Учебная редакция изменилась.", 409);
  if (!content.sourceCardIds.length)
    return Response.json({ status: "sources-required" });
  if (input.action === "rewrite") {
    const whole = input.chunkId
      ? content.sections
          .flatMap(({ chunks }) => chunks)
          .find(({ id }) => id === input.chunkId)?.content
      : content.lead;
    if (
      !whole ||
      input.end > whole.length ||
      input.end <= input.start ||
      input.end - input.start > 2000
    )
      return Response.json({ status: "too-long" });
    const text = whole
      .slice(input.start, input.end)
      .trim()
      .replace(/\s+/gu, " ");
    if (!text) return Response.json({ status: "failed" });
    return Response.json({
      status: "ready",
      suggestion: { action: "rewrite", text },
      sourceVersions: content.sourceVersions,
      staleSources: [],
    });
  }
  return Response.json({
    status: "ready",
    suggestion: {
      action: "variant",
      title: content.title.slice(0, 240),
      lead: content.lead.slice(0, 1000),
      body: content.sections
        .flatMap(({ chunks }) => chunks.map(({ content }) => content))
        .join("\n\n")
        .slice(0, 3000),
    },
    sourceVersions: content.sourceVersions,
    staleSources: [],
  });
}

function articlesResource(
  call: DemoCall,
  state: BrowserDemoState,
  user: SessionUser,
  id?: string
) {
  const articles = demoArticles(state);
  const articleId = id || call.url.searchParams.get("id");
  const article = articles.find((item) => item.id === articleId);
  if (call.method === "GET")
    return articleId
      ? article
        ? Response.json(article)
        : demoError("Учебная статья не найдена.", 404)
      : Response.json(articles);
  if (user.role !== "admin")
    return demoError("Учебную библиотеку редактирует координатор.", 403);
  const record = (
    item: ReadyArticle,
    data: Omit<NonNullable<BrowserDemoState["articleUpdates"]>[number], "id">
  ) => ({ id: item.id, ...data });
  if (
    call.method === "DELETE" &&
    call.url.searchParams.get("scope") === "demo"
  ) {
    call.save({
      ...state,
      articleUpdates: articles.map((item) => record(item, { deleted: true })),
    });
    return Response.json({ success: true });
  }
  if (!article) return demoError("Учебная статья не найдена.", 404);
  const rest = (state.articleUpdates ?? []).filter(
    (item) => item.id !== article.id
  );
  if (call.method === "DELETE") {
    call.save({
      ...state,
      articleUpdates: [...rest, record(article, { deleted: true })],
    });
    return Response.json({ success: true });
  }
  if (call.method === "PUT") {
    const input = saveArticleInputSchema.parse(call.body());
    const { title, lead, sections, universityId, projectTitle, topic } = input;
    const update = record(article, {
      title,
      lead,
      sections,
      universityId,
      projectTitle,
      topic,
      updatedAt: nextDemoTimestamp(article.updatedAt),
    });
    call.save({ ...state, articleUpdates: [...rest, update] });
    return Response.json({ ...article, ...update });
  }
}

export const handleDemoEditor: DemoHandler = (call) => {
  const path = call.url.pathname;
  const draftRoute =
    /^\/api\/editor\/drafts(?:\/([^/]+)(?:\/(readiness|docx))?)?$/.exec(path);
  const articles = /^\/api\/articles(?:\/([^/]+))?$/.exec(path);
  if (
    !draftRoute &&
    !articles &&
    ![
      "/api/editor/sources",
      "/api/editor/generate",
      "/api/editor/assist",
    ].includes(path)
  )
    return;
  const state = call.state;
  const user = demoUser(state);
  if (articles) return articlesResource(call, state, user, articles[1]);
  if (user.role === "guest")
    return demoError("Учебные черновики доступны сотрудникам.", 403);
  if (path === "/api/editor/sources" && call.method === "GET")
    return Response.json(
      approvedDemoCards(state).map((card) => ({
        id: card.id,
        title: card.title,
        versionId: demoCardVersionId(card),
      }))
    );
  if (path === "/api/editor/generate" && call.method === "POST")
    return generateArticle(call, state);
  if (path === "/api/editor/assist" && call.method === "POST")
    return editorAssist(call, state, user);
  if (!draftRoute) return;
  const [, id, resource] = draftRoute;
  const rows = demoEditorialRows(state).filter(({ document }) =>
    canReadEditorial(user, document)
  );
  if (!id && call.method === "GET")
    return Response.json({
      documents: rows.map(({ document }) => document),
      legacyArticles: [],
    });
  if (!id && call.method === "POST") return createDraft(call, state, user);
  const row = rows.find(({ document }) => document.id === id);
  if (!row) return demoError("Учебный черновик не найден.", 404);
  const { document, revisions } = row;
  if (resource === "docx" && call.method === "GET")
    return downloadDraft(call, row);
  if (resource === "readiness" && ["GET", "POST"].includes(call.method))
    return draftSnapshot(call, state, row);
  if (resource) return;
  if (call.method === "GET")
    return Response.json({
      document,
      revisions: [...revisions].reverse(),
      reviewers: document.ownerId === user.id ? reviewOptions(document) : [],
    });
  if (call.method === "PATCH") return updateDraft(call, state, row, user);
  if (call.method === "DELETE") {
    const { version } = deleteEditorialSchema.parse(call.body());
    if (document.ownerId !== user.id)
      return demoError("Учебный черновик не найден.", 404);
    if (!canDeleteEditorial(user, document) || document.version !== version)
      throw new EditorialError(
        "Учебный черновик изменился или находится на согласовании.",
        409
      );
    call.save({
      ...state,
      documents: state.documents.filter((doc) => doc.id !== id),
      editorialRows: (state.editorialRows ?? []).filter(
        (row) => row.document.id !== id
      ),
    });
    return Response.json({ success: true });
  }
};
