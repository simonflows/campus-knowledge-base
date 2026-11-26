import { canUseStaffWorkflow, type SessionUser } from "./auth";
import { isDatabaseAvailable } from "./db";
import { listEditorial } from "./editorial-models";
import { getEditorialReadiness } from "./editorial-readiness";
import { listInformationRequests } from "./information-requests-models";
import { getApprovedVersion } from "./knowledge";
import { getCardVersionId } from "./knowledge-versions";
import { getAllKnowledgeCards } from "./models";
import { staffDirectory } from "./account-directory";
import { buildUniversityCoverage, buildWorkQueue, type QueueReadiness } from "./work-queue";
import { listWorkflowRecords } from "./workflow-models";
import { WorkflowError } from "./workflow";

export async function getWorkData(user: SessionUser) {
  if (!canUseStaffWorkflow(user)) throw new WorkflowError("Работа с материалами доступна сотрудникам", 403);
  if (!(await isDatabaseAvailable())) throw new WorkflowError("Общая база временно недоступна", 503);
  const [cards, documents, requests, workflows] = await Promise.all([
    getAllKnowledgeCards(), listEditorial(user), listInformationRequests(user), listWorkflowRecords(user),
  ]);
  const readiness: Record<string, QueueReadiness> = {};
  const currentDocuments: typeof documents = [];
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, documents.length) }, async () => {
    while (index < documents.length) {
      const document = documents[index++];
      try {
        readiness[document.id] = await getEditorialReadiness(user, document.id);
        currentDocuments.push(document);
      } catch (error) {
        if (!(error instanceof Error && "status" in error && [403, 404].includes(Number(error.status)))) throw error;
      }
    }
  }));
  const people = (await staffDirectory()).filter(canUseStaffWorkflow).map(person => ({ id: person.id, name: person.name, organization: person.organization }));
  const names = new Map(people.map(person => [person.id, person.name]));
  const items = buildWorkQueue(user, { cards, documents: currentDocuments, requests, workflows: workflows.map(item => item.record), readiness });
  return {
    user: { id: user.id, name: user.name, role: user.role },
    items: items.map(item => ({ ...item, responsibleName: item.responsibleId ? names.get(item.responsibleId) ?? item.responsibleName : item.responsibleName })),
    workflows, people,
    sources: cards.flatMap(card => { const approved = getApprovedVersion(card); return approved ? [{ cardId: approved.id, versionId: getCardVersionId(approved), title: approved.title }] : []; }),
    documents: currentDocuments.map(document => ({ id: document.id, title: document.content.title || "Материал без названия", channel: document.channel, status: document.status })),
    coverage: user.role === "admin" ? buildUniversityCoverage(user, cards) : null,
  };
}
export type WorkData = Awaited<ReturnType<typeof getWorkData>>;
