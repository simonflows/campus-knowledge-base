import assert from "node:assert/strict";
import { test } from "node:test";

import { canRequestEdit, isCardOwner, type SessionUser } from "../lib/auth";
import { mockKnowledgeCards } from "../lib/mock-data";

const author = {
  id: "author-test",
  name: "Внешний автор",
  role: "author",
  organization: "Частный автор",
  position: "",
  ownershipLabel: "Внешний автор",
  ownerAliases: ["Внешний автор"],
  organizationAliases: [],
} as unknown as SessionUser;

test("an author cannot file a card edit request for a public card", () => {
  const card = mockKnowledgeCards.find((item) => item.status === "approved") ?? mockKnowledgeCards[0];
  assert.ok(card);
  assert.equal(canRequestEdit(author, card), false);
});

test("an author cannot act as card owner even when added to a legacy ownership field", () => {
  assert.equal(isCardOwner(author, ["Внешний автор"], [author.id]), false);
});
