import {
  getApprovedVersion,
  getRequiredUniversityApprovals,
  isCardReadyForPublication,
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

/** Joint approvals belong to the exact card content, not to its permanent ID. */
export function knowledgeUpdateModeration(
  current: KnowledgeCard,
  input: KnowledgeCardInput,
  editor?: { id: string; name: string; isAdmin: boolean }
): Partial<
  Pick<
    KnowledgeCard,
    | "status"
    | "participantApprovals"
    | "approvedSnapshot"
    | "requiredApprovalUniversityIds"
    | "submittedBy"
    | "submittedByName"
    | "reviewedBy"
    | "reviewedAt"
    | "reviewComment"
  >
> {
  const changed = Object.keys(input).some(
    (key) => key !== "ownerIds" && key !== "changeReason" &&
      JSON.stringify(current[key as keyof KnowledgeCard]) !==
      JSON.stringify(input[key as keyof KnowledgeCardInput])
  );
  if (!changed) return {};
  const joint =
    getRequiredUniversityApprovals(current).length > 0 ||
    (current.type === "project" && current.isJoint) ||
    (input.type === "project" && input.isJoint);
  const readyForPublication = isCardReadyForPublication(input);
  if (!joint && (!editor || editor.isAdmin) && readyForPublication) return {};
  const published = getApprovedVersion(current);
  const snapshot = published
    ? (Object.fromEntries(
        Object.entries(published).filter(([key]) => key !== "approvedSnapshot")
      ) as KnowledgeCard)
    : null;
  return {
    status: "pending" as const,
    participantApprovals: [],
    ...(snapshot ? { approvedSnapshot: snapshot } : {}),
    requiredApprovalUniversityIds: joint
      ? [
          ...new Set([
            ...getRequiredUniversityApprovals(current),
            ...(input.type === "project" ? input.participantUniversityIds : []),
          ]),
        ]
      : [],
    submittedBy: editor?.id ?? current.submittedBy,
    submittedByName: editor?.name ?? current.submittedByName,
    reviewedBy: "",
    reviewedAt: "",
    reviewComment: !readyForPublication
      ? "Перед согласованием уточните стадию и контур проекта по источникам."
      : joint
      ? "Содержание изменено: требуется новое подтверждение вузов-участников и координатора."
      : "Содержание изменено: требуется проверка координатора.",
  };
}
