import { z } from "zod";
import { canSeeCard, type SessionUser } from "./auth";
import { getApprovedVersion, getCardStatus, type KnowledgeCard } from "./knowledge";
import { universities } from "./data";
export const requestStatusLabels = {
  open: "Ожидает ответа",
  answered: "Получен ответ",
  submitted: "На подтверждении координатора",
  approved: "Карточка утверждена",
  rejected: "Карточка отклонена",
  unavailable: "Карточка недоступна",
} as const;
export type InformationRequest = {
  id: string;
  authorId: string;
  authorName: string;
  authorOrganization: string;
  recipientUniversityId: string;
  subject: string;
  question: string;
  linkedCardId: string | null;
  status: keyof typeof requestStatusLabels;
  answer: string | null;
  evidenceUrl: string | null;
  answeredBy: string | null;
  candidateCardId: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  creationDigest: string;
  lastOperationId: string | null;
  lastOperationDigest: string | null;
  participantIds?: string[];
  responsibleId?: string | null;
  responsibleName?: string;
  dueDate?: string | null;
};
/** Render the decision from the same card that moderation updates. Never persist this view. */
export function presentInformationRequest(
  item: InformationRequest, user: SessionUser, linked: KnowledgeCard | null, candidate: KnowledgeCard | null
): InformationRequest {
  const visibleId = (card: KnowledgeCard | null) =>
    card && (canSeeCard(user, card) || getApprovedVersion(card)) ? card.id : null;
  let status = item.status;
  if (status === "submitted") {
    if (!candidate) status = "unavailable";
    else if (getApprovedVersion(candidate)) status = "approved";
    else if (getCardStatus(candidate) === "rejected") status = "rejected";
  }
  return { ...item, status, linkedCardId: visibleId(linked), candidateCardId: visibleId(candidate) };
}
export const mockInformationRequests: InformationRequest[] = [];
export const universityIdSchema = z
  .string()
  .refine(
    (value) => universities.some((item) => item.id === value),
    "Выберите вуз-получатель"
  );
export const createInformationRequestSchema = z.object({
  operationId: z.uuid(),
  recipientUniversityId: universityIdSchema,
  subject: z.string().trim().min(3).max(180),
  question: z.string().trim().min(10).max(4000),
  linkedCardId: z.string().max(200).nullable().default(null),
  responsibleId: z.string().min(1).max(100).nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
});
export const updateInformationRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["join", "leave"]), operationId: z.uuid(), revision: z.number().int().min(0) }),
  z.object({ action: z.literal("assign"), operationId: z.uuid(), revision: z.number().int().min(0), responsibleId: z.string().min(1).max(100).nullable(), dueDate: z.iso.date().nullable() }),
  z.object({
    action: z.literal("answer"),
    operationId: z.uuid(),
    revision: z.number().int().min(0),
    answer: z.string().trim().min(10).max(10000),
    evidenceUrl: z
      .url()
      .max(2000)
      .refine((value) => value.startsWith("https://"), "Нужна HTTPS-ссылка"),
  }),
  z.object({
    action: z.literal("submit"),
    operationId: z.uuid(),
    revision: z.number().int().min(0),
  }),
]);
export function canSeeInformationRequest(
  user: SessionUser | null,
  item: InformationRequest
): boolean {
  return (
    !!user &&
    user.role !== "guest" &&
    (user.role === "admin" ||
      item.authorId === user.id ||
      (!!user.universityId &&
        user.universityId === item.recipientUniversityId &&
        ["university_owner", "university_pr"].includes(user.role)))
  );
}
export function canAnswerInformationRequest(
  user: SessionUser,
  item: InformationRequest
): boolean {
  return (
    user.universityId === item.recipientUniversityId &&
    ["university_owner", "university_pr"].includes(user.role)
  );
}
