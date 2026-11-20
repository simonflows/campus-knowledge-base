import { canSeeCard, type SessionUser } from "./auth";
import type { CampusSearchResult } from "./campus-services";
import {
  getApprovedVersion,
  getCardTypeLabel,
  type KnowledgeCard,
} from "./knowledge";
import { getSearchFragment, searchKnowledgeCards } from "./knowledge-search";

export function findHomeCards(
  cards: KnowledgeCard[],
  query: string,
  user: SessionUser | null
): CampusSearchResult[] {
  if (!query.trim()) return [];
  const approvedCards = cards.flatMap((card) => {
    const approved = getApprovedVersion(card);
    return approved && canSeeCard(user, approved) ? [approved] : [];
  });
  return searchKnowledgeCards(approvedCards, query)
    .slice(0, 5)
    .map((card) => {
      const fragment = getSearchFragment(card, query);
      return {
        title: card.title,
        detail: fragment === card.title ? getCardTypeLabel(card) : fragment,
        href: `/knowledge?card=${encodeURIComponent(card.id)}&version=approved`,
      };
    });
}
