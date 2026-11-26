import { staffDirectory } from "@/lib/account-directory";
import { canUseStaffWorkflow } from "@/lib/auth";
import { createWorkflowRecord, getWorkflowRecord, listWorkflowRecords } from "@/lib/workflow-models";
import { readWorkflowBody, workflowFailure, workflowJson, workflowUser } from "@/lib/workflow-http";
import { createWorkflowSchema } from "@/lib/validation/workflow";

export async function GET() {
  try {
    const user = await workflowUser();
    return workflowJson({ items: await listWorkflowRecords(user), people: (await staffDirectory()).filter(canUseStaffWorkflow).map(person => ({ id: person.id, name: person.name, organization: person.organization })) });
  } catch (error) { return workflowFailure(error); }
}
export async function POST(request: Request) {
  try {
    const user = await workflowUser(request);
    const parsed = createWorkflowSchema.safeParse(await readWorkflowBody(request));
    if (!parsed.success) return workflowJson({ error: parsed.error.issues[0]?.message ?? "Проверьте поля формы" }, 400);
    const record = await createWorkflowRecord(user, parsed.data);
    return workflowJson(await getWorkflowRecord(user, record.id), 201);
  } catch (error) { return workflowFailure(error); }
}
