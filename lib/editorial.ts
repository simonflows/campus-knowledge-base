import { z } from "zod";
import type { SessionUser } from "./auth";
import { sourceVersionsSchema } from "./source-references";

export const editorialContentSchema = z
  .object({
    title: z.string().max(240).default(""),
    lead: z.string().max(4000).default(""),
    query: z.string().max(2000).default(""),
    topic: z.string().max(240).default(""),
    audience: z.string().max(240).default(""),
    outlet: z.string().max(240).default(""),
    length: z.string().max(100).default(""),
    universityId: z.string().max(100).default(""),
    projectTitle: z.string().max(240).default(""),
    sourceCardIds: z.array(z.string().min(1).max(200)).max(100).default([]),
    sourceCardTitles: z.array(z.string().max(500)).max(100).default([]),
    sourceVersions: sourceVersionsSchema.optional(),
    sections: z
      .array(
        z.object({
          id: z.string().min(1).max(100),
          heading: z.string().max(300),
          level: z.union([z.literal(2), z.literal(3)]),
          chunks: z
            .array(
              z.object({
                id: z.string().min(1).max(100),
                content: z.string().max(4000),
              })
            )
            .max(12),
        })
      )
      .max(20)
      .default([]),
  })
  .superRefine((value, ctx) => {
    const pinned = value.sourceVersions ?? [];
    const listed = new Set(value.sourceCardIds);
    if (new Set(pinned.map((source) => source.cardId)).size !== pinned.length ||
        pinned.some((source) => !listed.has(source.cardId))) {
      ctx.addIssue({ code: "custom", path: ["sourceVersions"], message: "Укажите одну версию для каждого выбранного источника" });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).length > 240_000)
      ctx.addIssue({
        code: "custom",
        message:
          "Объём материала превышает 240 КБ. Разделите его на несколько материалов.",
      });
    const ids = value.sections.flatMap((s) => [
      s.id,
      ...s.chunks.map((c) => c.id),
    ]);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        message: "Идентификаторы абзацев должны быть уникальными",
      });
  });
export type EditorialContent = z.infer<typeof editorialContentSchema>;
export type EditorialEvent = {
  id: string;
  action:
    | "created"
    | "saved"
    | "restored"
    | "submitted"
    | "returned"
    | "approved"
    | "commented";
  revisionId: string;
  actorId: string;
  actorName: string;
  at: string;
  comment: string;
};
export type EditorialDocument = {
  id: string;
  ownerId: string;
  ownerName: string;
  originalId: string;
  channel: string;
  version: number;
  revisionId: string;
  submittedRevisionId: string | null;
  approvedRevisionId: string | null;
  status: "draft" | "submitted" | "returned" | "approved";
  content: EditorialContent;
  createdAt: string;
  updatedAt: string;
  events: EditorialEvent[];
  legacyArticleId?: string;
  submittedOnce?: boolean;
  reviewerId?: string;
  reviewerName?: string;
};
export type EditorialRevision = {
  id: string;
  documentId: string;
  number: number;
  content: EditorialContent;
  actorId: string;
  actorName: string;
  createdAt: string;
  restoredFrom?: string;
};
export const createEditorialSchema = z.object({
  content: editorialContentSchema.default(() =>
    editorialContentSchema.parse({})
  ),
  originalId: z.string().max(100).optional(),
  channel: z.string().max(100).default("Оригинал"),
  legacyArticleId: z.string().max(100).optional(),
});
export const editorialMutationSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    version: z.number().int().positive(),
    content: editorialContentSchema,
  }),
  z.object({
    action: z.literal("restore"),
    version: z.number().int().positive(),
    revisionId: z.string().min(1).max(100),
  }),
  z.object({
    action: z.enum(["submit", "return", "approve", "comment"]),
    version: z.number().int().positive(),
    revisionId: z.string().min(1).max(100),
    comment: z.string().trim().max(2000).default(""),
    reviewerId: z.string().max(100).optional(),
  }),
]);
export type EditorialMutation = z.infer<typeof editorialMutationSchema>;
export const editorialStatusLabels = {
  draft: "Черновик",
  submitted: "На согласовании",
  returned: "Возвращён на доработку",
  approved: "Согласовано",
};
export const editorialEventLabels: Record<EditorialEvent["action"], string> = {
  created: "Создан черновик",
  saved: "Сохранена редакция",
  restored: "Восстановлена редакция",
  submitted: "Отправлено на согласование",
  returned: "Возвращено на доработку",
  approved: "Согласовано",
  commented: "Добавлен комментарий",
};
export function canReadEditorial(user: SessionUser, doc: EditorialDocument) {
  if (user.role === "guest") return false;
  if (doc.ownerId === user.id) return true;
  if (doc.status === "draft") return false;
  if (!doc.reviewerId) return user.role === "admin";
  return doc.reviewerId === user.id && (
    user.role === "admin" ||
    (user.role === "university_owner" && user.universityId === doc.content.universityId)
  );
}
export function canWriteEditorial(user: SessionUser, doc: EditorialDocument) {
  return user.role !== "guest" && doc.ownerId === user.id;
}
export function editorialText(content: EditorialContent) {
  return [
    content.title,
    content.lead,
    ...content.sections.flatMap((s) => [
      s.heading,
      ...s.chunks.map((c) => c.content),
    ]),
  ].join("\n\n");
}
export class EditorialError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}
export function validateEditorialAction(
  user: SessionUser,
  doc: EditorialDocument,
  mutation: EditorialMutation
) {
  if (!canReadEditorial(user, doc))
    throw new EditorialError("Черновик не найден", 404);
  if (doc.version !== mutation.version)
    throw new EditorialError(
      "В другой вкладке сохранена новая версия. Ваш текст сохранён на устройстве: откройте актуальную версию и сравните изменения.",
      409
    );
  if (
    ["save", "restore", "submit"].includes(mutation.action) &&
    !canWriteEditorial(user, doc)
  )
    throw new EditorialError(
      "Изменять и отправлять черновик может только его автор",
      403
    );
  if (
    ["return", "approve"].includes(mutation.action) &&
    (doc.ownerId === user.id ||
      !["admin", "university_owner"].includes(user.role) ||
      (doc.reviewerId ? doc.reviewerId !== user.id : user.role !== "admin"))
  )
    throw new EditorialError(
      "Согласование доступно назначенному руководителю или координатору; самосогласование запрещено",
      403
    );
  if (
    (mutation.action === "return" || mutation.action === "approve") &&
    (doc.status !== "submitted" ||
      doc.submittedRevisionId !== mutation.revisionId ||
      doc.revisionId !== mutation.revisionId)
  )
    throw new EditorialError("На согласование отправлена другая редакция", 409);
  if (mutation.action === "submit" && mutation.revisionId !== doc.revisionId)
    throw new EditorialError("Отправить можно только актуальную редакцию", 409);
  if (
    (mutation.action === "return" || mutation.action === "comment") &&
    !mutation.comment.trim()
  )
    throw new EditorialError("Добавьте комментарий");
}
