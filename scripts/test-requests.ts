import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { requireFixtureDatabase } from "./qa-fixture";
import { installPilotFixture } from "./pilot-fixture";
import { createInformationRequest, listInformationRequests, mutateInformationRequest, presentRequestFor, RequestError } from "../lib/information-requests-models";
import { docClient } from "../lib/db";
import { knowledgeSeedCards } from "../lib/knowledge";
import { getKnowledgeCardById, setKnowledgeCardModeration } from "../lib/models";
import { TableName } from "../lib/schema";

async function main() {
  await requireFixtureDatabase();
  const people = installPilotFixture();
  const author = people.account("demo-owner-susu");
  const recipient = people.account("demo-pr-midis");
  const recipientLeader = people.account("demo-owner-midis");
  const outsider = people.account("demo-pr-csu");
  const source = {
    ...knowledgeSeedCards.find(({ id }) => id === "project-midis-service-design")!,
    id: `qa-request-source-${randomUUID()}`,
    status: "approved" as const,
  };
  await docClient.send(new PutCommand({
    TableName: TableName.KNOWLEDGE_CARDS,
    Item: source,
    ConditionExpression: "attribute_not_exists(id)",
  }));
  const create = {
    operationId: randomUUID(),
    recipientUniversityId: "midis",
    subject: "QA повтор отправки запроса",
    question: "Проверка повторной отправки с отозванной связанной карточкой",
    linkedCardId: source.id,
  };
  const created = await createInformationRequest(author, create);
  const withdrawn = await setKnowledgeCardModeration(source.id, { status: "rejected" }, source.updatedAt);
  assert.equal(withdrawn?.status, "rejected");
  assert.equal((await presentRequestFor(author, created)).linkedCardId, null);
  assert.equal((await createInformationRequest(author, create)).id, created.id);
  await assert.rejects(createInformationRequest(author, { ...create, subject: "Изменённое повторное обращение" }),
    (error) => error instanceof RequestError && error.status === 409);
  await assert.rejects(createInformationRequest(author, { ...create, operationId: randomUUID() }),
    (error) => error instanceof RequestError && error.status === 404);

  const sameCreate = { ...create, operationId: randomUUID(), linkedCardId: null };
  const [firstCreate, repeatedCreate] = await Promise.all([
    createInformationRequest(author, sameCreate),
    createInformationRequest(author, sameCreate),
  ]);
  assert.deepEqual(firstCreate, repeatedCreate);
  const sameAnswer = {
    action: "answer" as const,
    revision: firstCreate.revision,
    operationId: randomUUID(),
    answer: "Синтетический ответ, отправленный одновременно из двух вкладок",
    evidenceUrl: "https://example.org/evidence",
  };
  const [firstAnswer, repeatedAnswer] = await Promise.all([
    mutateInformationRequest(recipient, firstCreate.id, sameAnswer),
    mutateInformationRequest(recipient, firstCreate.id, sameAnswer),
  ]);
  assert.deepEqual(firstAnswer, repeatedAnswer);
  assert.equal(firstAnswer.revision, 1);
  const sameSubmit = {
    action: "submit" as const,
    revision: firstAnswer.revision,
    operationId: randomUUID(),
  };
  const [firstSubmit, repeatedSubmit] = await Promise.all([
    mutateInformationRequest(author, firstCreate.id, sameSubmit),
    mutateInformationRequest(author, firstCreate.id, sameSubmit),
  ]);
  assert.deepEqual(firstSubmit, repeatedSubmit);
  assert.equal(firstSubmit.revision, 2);
  assert.equal(firstSubmit.candidateCardId, `request-${firstCreate.id}`);
  const candidate = await getKnowledgeCardById(firstSubmit.candidateCardId);
  assert.ok(candidate);
  assert.deepEqual(candidate.owners, [recipientLeader.ownershipLabel]);
  console.log("PASS retries with a withdrawn source and simultaneous create, answer and submit");

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
