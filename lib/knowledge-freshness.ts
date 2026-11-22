import { canAssignCardOwner, canEditCard, type SessionUser } from "./auth";
import { getApprovedVersion, type KnowledgeCard } from "./knowledge";

export function canVerifyCardFreshness(
  user: SessionUser | null,
  card: KnowledgeCard
): boolean {
  const published = getApprovedVersion(card);
  if (!published || !user) return false;
  return (
    canEditCard(user, card) ||
    (card.freshness?.responsibleId === user.id &&
      canAssignCardOwner(user, published))
  );
}

export function isReviewOverdue(
  nextReviewAt: string | null | undefined,
  now: string | number | Date = new Date()
): nextReviewAt is string {
  if (!nextReviewAt) return false;
  const instant = now instanceof Date ? now : new Date(now);
  return (
    Number.isFinite(instant.getTime()) &&
    nextReviewAt < instant.toISOString().slice(0, 10)
  );
}
