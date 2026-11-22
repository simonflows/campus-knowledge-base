import { z } from "zod";

import { articleSeed, type ReadyArticle } from "./articles";
import {
  canAssignCardOwner,
  canCreateCard,
  canEditCard,
  getDemoAccount,
  isCardOwner,
  toSessionUser,
} from "./auth";
import { editorialContentSchema, editorialText } from "./editorial";
import { checkFactText } from "./fact-check";
import {
  folderIds,
  getCardStatus,
  getPublicApprovedCard,
  getRequiredUniversityApprovals,
  getUniversityIdFromFolder,
  isCardReadyForPublication,
  knowledgeSeedCards,
  type KnowledgeCard,
} from "./knowledge";
import {
  knowledgeCardInputSchema,
  type KnowledgeCardInput,
} from "./validation/knowledge";

export const BROWSER_DEMO_KEY = "campus-browser-demo:v1";
export const DEMO_EXERCISE_ID = "demo-joint-exercise";
const MAX_PAYLOAD_CHARS = 1_500_000;
const MAX_EDITS = 120;
const MAX_MATERIALS = 40;
const DEFAULT_PROFILE = "demo-pr-midis";

type DemoStorage = Pick<Storage, "getItem" | "setItem">;

const cardMetadataSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["approved", "pending", "rejected"]).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const storedCardSchema = z.intersection(
  knowledgeCardInputSchema,
  cardMetadataSchema.extend({
    ownerIds: z.array(z.string()).optional(),
    submittedBy: z.string().optional(),
    submittedByName: z.string().optional(),
    reviewedAt: z.iso.datetime().optional(),
    reviewedBy: z.string().optional(),
    participantApprovals: z.array(z.string()).max(7).optional(),
    approvedSnapshot: z
      .intersection(knowledgeCardInputSchema, cardMetadataSchema)
      .optional(),
  })
);

const demoDocumentSchema = z.object({
  id: z.string().min(1),
  author: z.string().refine((id) => Boolean(getDemoAccount(id))),
  status: z.enum(["draft", "submitted", "approved", "returned"]),
  content: editorialContentSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const demoStateSchema = z.object({
  version: z.literal(1),
  profile: z.string().refine((id) => Boolean(getDemoAccount(id))),
  updates: z
    .array(storedCardSchema)
    .max(MAX_EDITS)
    .refine(
      (cards) => new Set(cards.map((card) => card.id)).size === cards.length
    ),
  documents: z
    .array(demoDocumentSchema)
    .max(MAX_MATERIALS)
    .refine(
      (records) =>
        new Set(records.map((record) => record.id)).size === records.length
    ),
});

export type DemoDocument = z.infer<typeof demoDocumentSchema>;
export type BrowserDemoState = Omit<
  z.infer<typeof demoStateSchema>,
  "updates"
> & {
  updates: KnowledgeCard[];
};

function createBrowserDemo(): BrowserDemoState {
  return { version: 1, profile: DEFAULT_PROFILE, updates: [], documents: [] };
}

export function getDemoError(error: unknown) {
  if (error instanceof z.ZodError)
    return error.issues[0]?.message ?? "Проверьте введённые данные.";
  return error instanceof Error
    ? error.message
    : "Не удалось выполнить действие в демо.";
}

export function readBrowserDemo(storage: DemoStorage): BrowserDemoState {
  let raw: string | null;
  try {
    raw = storage.getItem(BROWSER_DEMO_KEY);
  } catch {
    throw new Error("Браузер не разрешил прочитать хранилище демо.");
  }
  if (raw === null) return createBrowserDemo();
  if (raw.length <= MAX_PAYLOAD_CHARS) {
    try {
      const result = demoStateSchema.safeParse(JSON.parse(raw));
      if (result.success) return result.data as BrowserDemoState;
    } catch {
      // The original value is retained until the visitor explicitly resets it.
    }
  }
  throw new Error(
    "Хранилище демо повреждено или использует другую версию. Вы можете явно начать демо заново."
  );
}

export function writeBrowserDemo(
  storage: DemoStorage,
  state: BrowserDemoState
) {
  const raw = JSON.stringify(state);
  if (raw.length > MAX_PAYLOAD_CHARS) {
    throw new Error(
      "Достигнут лимит хранилища демо. Сократите содержимое или начните демо заново."
    );
  }
  try {
    storage.setItem(BROWSER_DEMO_KEY, raw);
  } catch {
    throw new Error(
      "Не удалось сохранить изменения в браузере. Проверьте разрешения и свободное место."
    );
  }
}

export function resetBrowserDemo(storage: DemoStorage) {
  const state = createBrowserDemo();
  writeBrowserDemo(storage, state);
  return state;
}

const sampleJoint = knowledgeSeedCards.find(
  (card) => card.id === "joint-midis-susmu-trauma"
);
const seedCards = [
  ...knowledgeSeedCards,
  ...(sampleJoint?.type === "project"
    ? [
        {
          ...sampleJoint,
          id: DEMO_EXERCISE_ID,
          title: "Учебный совместный проект МИДиС и ЮУГМУ",
          industrialPartner: "Учебный партнёр",
          confirmedFigures: ["1 учебный прототип"],
          referenceDescription:
            "Учебный проект для согласования карточки двумя вузами и координатором.",
          stopFormula:
            "Учебный пример. Не используйте сведения этого проекта в рабочих материалах.",
          ownerIds: ["demo-owner-midis", "demo-owner-susmu"],
          submittedBy: DEFAULT_PROFILE,
          status: "pending" as const,
        },
      ]
    : []),
];

export function demoUser(state: BrowserDemoState) {
  return toSessionUser(
    getDemoAccount(state.profile) ?? getDemoAccount(DEFAULT_PROFILE)!
  );
}

export function selectDemoProfile(
  state: BrowserDemoState,
  profile: string
): BrowserDemoState {
  if (!getDemoAccount(profile)) throw new Error("Выберите учебный профиль.");
  return { ...state, profile };
}

export function getDemoCard(state: BrowserDemoState, id: string) {
  return (
    state.updates.find((card) => card.id === id) ??
    seedCards.find((card) => card.id === id)
  );
}

function allDemoCards(state: BrowserDemoState) {
  const cards = new Map(seedCards.map((card) => [card.id, card]));
  for (const card of state.updates) cards.set(card.id, card);
  return Array.from(cards.values());
}

export function canEditDemoCard(state: BrowserDemoState, card: KnowledgeCard) {
  return canEditCard(demoUser(state), card);
}

export function visibleDemoCards(state: BrowserDemoState): KnowledgeCard[] {
  const user = demoUser(state);
  return allDemoCards(state).flatMap((card) => {
    if (
      getCardStatus(card) === "approved" ||
      canEditDemoCard(state, card) ||
      (user.role !== "guest" && card.submittedBy === user.id) ||
      (getCardStatus(card) === "pending" &&
        isResponsibleParticipant(state, card))
    )
      return [card];
    const previous = getPublicApprovedCard(card);
    return previous ? [previous] : [];
  });
}

export function approvedDemoCards(state: BrowserDemoState) {
  return allDemoCards(state)
    .map(getPublicApprovedCard)
    .filter((card): card is KnowledgeCard => card !== null);
}

function updateCard(
  state: BrowserDemoState,
  card: KnowledgeCard
): BrowserDemoState {
  const updates = [
    ...state.updates.filter((previous) => previous.id !== card.id),
    card,
  ];
  if (updates.length > MAX_EDITS)
    throw new Error("Достигнут лимит изменений карточек в демо.");
  return { ...state, updates };
}

function nextTimestamp(previous?: string) {
  return new Date(
    Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)
  ).toISOString();
}

export function saveDemoCard(
  state: BrowserDemoState,
  input: KnowledgeCardInput,
  initial: KnowledgeCard | null = null
) {
  const user = demoUser(state);
  const parsed = knowledgeCardInputSchema.parse(input);
  const previous = initial ? getDemoCard(state, initial.id) : undefined;
  if (initial && (!previous || previous.updatedAt !== initial.updatedAt)) {
    throw new Error(
      "Карточка изменилась в другой вкладке. Откройте её заново."
    );
  }
  if (previous ? !canEditDemoCard(state, previous) : !canCreateCard(user)) {
    throw new Error("Этому учебному профилю недоступно сохранение карточки.");
  }
  const folderId =
    parsed.type === "project" && parsed.isJoint
      ? folderIds.joint
      : parsed.folderId;
  const scope =
    user.role === "university_pr"
      ? { role: "university_owner" as const, universityId: user.universityId }
      : user;
  if (
    user.role !== "admin" &&
    !canAssignCardOwner(scope, { ...parsed, folderId })
  ) {
    throw new Error("Выберите карточку или раздел своего учебного профиля.");
  }
  const approvedSnapshot = previous ? getPublicApprovedCard(previous) : null;
  const now = nextTimestamp(previous?.updatedAt);
  const universityId =
    parsed.type === "project"
      ? parsed.initiatorUniversityId
      : getUniversityIdFromFolder(folderId);
  const universityIds =
    parsed.type === "project" && parsed.isJoint
      ? parsed.participantUniversityIds
      : universityId
        ? [universityId]
        : [];
  const owners = universityIds.flatMap((id) => {
    const owner = getDemoAccount(`demo-owner-${id}`);
    return owner ? [owner] : [];
  });
  const ownerIds = owners.length
    ? owners.map((owner) => owner.id)
    : (previous?.ownerIds ?? (previous ? undefined : [user.id]));
  const card = {
    ...parsed,
    folderId,
    ...(owners.length
      ? { owners: owners.map((owner) => owner.ownershipLabel) }
      : {}),
    ownerIds,
    id: previous?.id ?? `demo-card-${crypto.randomUUID()}`,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    status: "pending",
    submittedBy: user.id,
    submittedByName: user.name,
    ...(approvedSnapshot && { approvedSnapshot }),
  } as KnowledgeCard;
  // Stored rows use the same validation after loading or across browser tabs.
  storedCardSchema.parse(card);
  return { state: updateCard(state, card), card };
}

function isResponsibleParticipant(
  state: BrowserDemoState,
  card: KnowledgeCard
) {
  const user = demoUser(state);
  return (
    user.role === "university_owner" &&
    Boolean(user.universityId) &&
    getRequiredUniversityApprovals(card).includes(user.universityId!) &&
    (user.soleUniversityOwner || isCardOwner(user, card.owners, card.ownerIds))
  );
}

export function canConfirmDemoParticipation(
  state: BrowserDemoState,
  card: KnowledgeCard
) {
  return (
    getCardStatus(card) === "pending" &&
    isResponsibleParticipant(state, card) &&
    !(card.participantApprovals ?? []).includes(demoUser(state).universityId!)
  );
}

export function moderateDemoCard(
  state: BrowserDemoState,
  id: string,
  action: "confirm" | "approve" | "return"
) {
  const user = demoUser(state);
  const card = getDemoCard(state, id);
  if (!card || getCardStatus(card) !== "pending") {
    throw new Error("Эта карточка сейчас не на учебной проверке.");
  }
  const updatedAt = nextTimestamp(card.updatedAt);
  if (action === "confirm") {
    if (!isResponsibleParticipant(state, card)) {
      throw new Error("Подтвердить участие может ответственный владелец вуза.");
    }
    if (!canConfirmDemoParticipation(state, card))
      throw new Error("Этот вуз уже подтвердил участие.");
    return updateCard(state, {
      ...card,
      updatedAt,
      participantApprovals: [
        ...(card.participantApprovals ?? []),
        user.universityId!,
      ],
    });
  }
  if (user.role !== "admin")
    throw new Error("Решение по карточке принимает координатор.");
  if (
    action === "approve" &&
    !getRequiredUniversityApprovals(card).every((id) =>
      card.participantApprovals?.includes(id)
    )
  ) {
    throw new Error("Дождитесь подтверждений всех вузов-участников.");
  }
  if (action === "approve" && !isCardReadyForPublication(card)) {
    throw new Error(
      "Укажите стадию готовности и контур проекта перед утверждением."
    );
  }
  if (action === "return") {
    return updateCard(state, {
      ...card,
      updatedAt,
      status: "rejected",
      reviewedAt: updatedAt,
      reviewedBy: user.name,
    });
  }
  return updateCard(state, {
    ...card,
    updatedAt,
    status: "approved",
    reviewedAt: updatedAt,
    reviewedBy: user.name,
    approvedSnapshot: undefined,
  });
}

export function visibleDemoDocuments(state: BrowserDemoState) {
  const user = demoUser(state);
  return state.documents.filter(
    (doc) =>
      doc.author === user.id ||
      (user.role === "admin" && doc.status === "submitted")
  );
}

export function saveDemoDocument(
  state: BrowserDemoState,
  content: DemoDocument["content"],
  initial: DemoDocument | null
) {
  const user = demoUser(state);
  if (user.role === "guest")
    throw new Error(
      "Выберите роль сотрудника для сохранения учебного черновика."
    );
  const previous = initial
    ? state.documents.find((doc) => doc.id === initial.id)
    : undefined;
  if (
    initial &&
    (!previous ||
      previous.updatedAt !== initial.updatedAt ||
      previous.author !== user.id ||
      !["draft", "returned"].includes(previous.status))
  ) {
    throw new Error(
      "Черновик изменился или ожидает решения. Откройте его заново."
    );
  }
  if (!previous && state.documents.length >= MAX_MATERIALS) {
    throw new Error("Достигнут лимит материалов в демо.");
  }
  const parsed = editorialContentSchema.parse(content);
  const approved = new Map(
    approvedDemoCards(state).map((card) => [card.id, card.title])
  );
  if (parsed.sourceCardIds.some((id) => !approved.has(id))) {
    throw new Error("Подберите утверждённые учебные источники заново.");
  }
  const now = nextTimestamp(previous?.updatedAt);
  const document: DemoDocument = {
    id: previous?.id ?? `demo-doc-${crypto.randomUUID()}`,
    author: user.id,
    status: "draft",
    content: {
      ...parsed,
      sourceCardTitles: parsed.sourceCardIds.map((id) => approved.get(id)!),
    },
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  return {
    state: {
      ...state,
      documents: [
        ...state.documents.filter((doc) => doc.id !== document.id),
        document,
      ],
    },
    document,
  };
}

export function moderateDemoDocument(
  state: BrowserDemoState,
  id: string,
  action: "submit" | "approve" | "return"
) {
  const document = state.documents.find((item) => item.id === id);
  const user = demoUser(state);
  if (!document) throw new Error("Учебный материал не найден.");
  if (action === "submit") {
    if (
      document.author !== user.id ||
      !["draft", "returned"].includes(document.status)
    ) {
      throw new Error("Отправить учебный черновик может его автор.");
    }
    if (user.role === "admin")
      throw new Error(
        "Создайте черновик от имени другой учебной роли, чтобы согласовать его у координатора."
      );
    const { title, lead, sections, sourceCardIds } = document.content;
    if (
      !title.trim() ||
      !lead.trim() ||
      !sections.some((section) =>
        section.chunks.some((chunk) => chunk.content.trim())
      ) ||
      !sourceCardIds.length
    ) {
      throw new Error(
        "Добавьте заголовок, лид, основной текст и хотя бы один источник."
      );
    }
  } else if (
    user.role !== "admin" ||
    document.status !== "submitted" ||
    document.author === user.id
  ) {
    throw new Error("Учебный материал согласует другой профиль координатора.");
  }
  if (action === "approve") {
    const ids = new Set(document.content.sourceCardIds);
    const sources = approvedDemoCards(state).filter((card) => ids.has(card.id));
    if (
      sources.length !== ids.size ||
      checkFactText(editorialText(document.content), sources).summary.red > 0
    ) {
      throw new Error(
        "Проверьте актуальность источников и исправьте красные замечания."
      );
    }
  }
  const status =
    action === "submit"
      ? "submitted"
      : action === "approve"
        ? "approved"
        : "returned";
  return {
    ...state,
    documents: state.documents.map((item) =>
      item.id === id
        ? ({
            ...item,
            status,
            updatedAt: nextTimestamp(item.updatedAt),
          } as DemoDocument)
        : item
    ),
  };
}

export function demoArticles(state: BrowserDemoState): ReadyArticle[] {
  const cards = new Set(approvedDemoCards(state).map((card) => card.id));
  const examples = articleSeed
    .filter((article) => article.sourceCardIds.every((id) => cards.has(id)))
    .map((article) => ({
      ...article,
      approval: {
        revisionId: `demo-${article.id}`,
        approvedBy: "Учебный пример",
        approvedAt: article.updatedAt,
      },
    }));
  return [
    ...state.documents
      .filter((doc) => doc.status === "approved")
      .map((doc) => ({
        ...doc.content,
        id: doc.id,
        query: "",
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        approval: {
          revisionId: doc.updatedAt,
          approvedBy: "Учебный координатор",
          approvedAt: doc.updatedAt,
        },
      })),
    ...examples,
  ];
}
