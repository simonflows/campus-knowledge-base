import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { requireFixtureDatabase } from "./qa-fixture";
import { installPilotFixture } from "./pilot-fixture";
import { createInformationRequest, listInformationRequests, mutateInformationRequest } from "../lib/information-requests-models";
import { getKnowledgeCardById, setKnowledgeCardModeration } from "../lib/models";

async function main() {
  await requireFixtureDatabase();
  const people = installPilotFixture();
  const author = people.account("demo-owner-susu");
  const recipient = people.account("demo-pr-midis");
  const outsider = people.account("demo-pr-csu");
  for (const result of ["approved", "rejected"] as const) {
    const item = await createInformationRequest(author, { operationId: randomUUID(), recipientUniversityId: "midis", subject: "QA согласование ответа", question: "Проверить итог рассмотрения синтетического ответа", linkedCardId: null });
    const answer = await mutateInformationRequest(recipient, item.id, { action: "answer", revision: 0, operationId: randomUUID(), answer: "Тестовый ответ для изолированной проверки", evidenceUrl: "https://example.org/evidence" });
    const submitted = await mutateInformationRequest(author, item.id, { action: "submit", revision: answer.revision, operationId: randomUUID() });
    const card = await getKnowledgeCardById(submitted.candidateCardId!);
    assert.ok(card);
    assert.equal((await listInformationRequests(recipient)).find(row => row.id === item.id)?.candidateCardId, null);
    await setKnowledgeCardModeration(card.id, { status: result, reviewedAt: new Date().toISOString(), reviewedBy: "QA" }, card.updatedAt);
    const shown = (await listInformationRequests(recipient)).find(row => row.id === item.id)!;
    assert.equal(shown.status, result);
    assert.equal(shown.candidateCardId, result === "approved" ? card.id : null);
    assert.equal((await listInformationRequests(author)).find(row => row.id === item.id)?.candidateCardId, card.id);
    assert.ok(!(await listInformationRequests(outsider)).some(row => row.id === item.id));
  }
  console.log("PASS request outcome after approval and rejection; pending/rejected card links obey ACL for author and recipient, unrelated university excluded");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
