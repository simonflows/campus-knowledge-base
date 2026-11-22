import {
  cardContent,
  getApprovedVersion,
  type KnowledgeCard,
} from "./knowledge";

function demoContentId(card: KnowledgeCard) {
  const content: Partial<KnowledgeCard> = cardContent(card);
  delete content.createdAt;
  delete content.updatedAt;
  delete content.status;
  delete content.freshness;
  delete content.changeReason;
  const key = JSON.stringify(content, (_name, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0
          )
        )
      : value
  );
  const prime = BigInt("1099511628211");
  const value = [...key].reduce(
    (hash, char) =>
      BigInt.asUintN(128, (hash ^ BigInt(char.codePointAt(0)!)) * prime),
    BigInt("14695981039346656037")
  );
  return `cv-${value.toString(16).padStart(64, "0")}`;
}

// The browser uses these identifiers only for educational source links and approvals.
export const demoCardRevisionId = demoContentId;
export const demoCardVersionId = (card: KnowledgeCard) =>
  demoContentId(getApprovedVersion(card) ?? card);
