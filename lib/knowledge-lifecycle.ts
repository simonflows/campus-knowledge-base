import {
  getApprovedVersion,
  getCardStatus,
  getRequiredUniversityApprovals,
  isCardReadyForPublication,
  stakeholderApprovalRoles,
  universityPassportSeeds,
  type KnowledgeCard,
} from "./knowledge";
import type { KnowledgeCardInput } from "./validation/knowledge";

export function missingUniversityPassports(cards: KnowledgeCard[]) {
  return universityPassportSeeds.filter(
    (seed) =>
      !cards.some(
        (card) =>
          card.id === seed.id ||
          (card.type === "university" &&
            card.universityId === seed.universityId)
      )
  );
}

/** A change to a pending proposal invalidates decisions on the previous proposal. */
export function knowledgeUpdateModeration(
  current: KnowledgeCard,
  input: KnowledgeCardInput,
  editor?: { id: string; name: string; isAdmin: boolean }
): Partial<
  Pick<
    KnowledgeCard,
    | "status"
    | "participantApprovals"
    | "participantApprovalRecords"
    | "requiredApprovalStakeholderRoles"
    | "stakeholderApprovals"
    | "approvedSnapshot"
    | "requiredApprovalUniversityIds"
    | "submittedBy"
    | "submittedByName"
    | "reviewedBy"
    | "reviewedAt"
    | "reviewComment"
  >
> {
  const contentChanged = Object.keys(input).some(
    (key) => key !== "ownerIds" && key !== "changeReason" &&
      JSON.stringify(current[key as keyof KnowledgeCard]) !==
      JSON.stringify(input[key as keyof KnowledgeCardInput])
  );
  const assignmentsChanged = getCardStatus(current) !== "approved" &&
    JSON.stringify(current.ownerIds) !== JSON.stringify(input.ownerIds);
  if (!contentChanged && !assignmentsChanged) return {};
  const published = getApprovedVersion(current);
  const requiredUniversityIds = [...new Set([
    ...(published ? getRequiredUniversityApprovals(published) : []),
    ...(current.type !== "project" ? getRequiredUniversityApprovals(current) : []),
    ...(input.type === "project" && input.isJoint ? input.participantUniversityIds : []),
  ])];
  const requiredStakeholders = [...new Set([
    ...(published ? stakeholderApprovalRoles(published) : []),
    ...stakeholderApprovalRoles(input),
  ])];
  const readyForPublication = isCardReadyForPublication(input);
  if (getCardStatus(current) === "approved" && !requiredUniversityIds.length && !requiredStakeholders.length &&
      (!editor || editor.isAdmin) && readyForPublication) return {};
  const snapshot = published
    ? (Object.fromEntries(
        Object.entries(published).filter(([key]) => key !== "approvedSnapshot")
      ) as KnowledgeCard)
    : null;
  return {
    status: "pending" as const,
    participantApprovals: [],
    participantApprovalRecords: {},
    requiredApprovalStakeholderRoles: requiredStakeholders,
    stakeholderApprovals: {},
    ...(snapshot ? { approvedSnapshot: snapshot } : {}),
    requiredApprovalUniversityIds: requiredUniversityIds,
    submittedBy: contentChanged ? editor?.id ?? current.submittedBy : current.submittedBy,
    submittedByName: contentChanged ? editor?.name ?? current.submittedByName : current.submittedByName,
    reviewedBy: "",
    reviewedAt: "",
    reviewComment: !readyForPublication
      ? "Перед согласованием уточните стадию и контур проекта по источникам."
      : requiredUniversityIds.length || requiredStakeholders.length
      ? "Редакция изменена: требуются новые подтверждения и решение координатора."
      : "Содержание изменено: требуется проверка координатора.",
  };
}
