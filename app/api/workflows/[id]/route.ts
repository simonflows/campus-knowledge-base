import { getWorkflowEvents, getWorkflowRecord, mutateWorkflowRecord } from "@/lib/workflow-models";
import { readWorkflowBody, workflowFailure, workflowJson, workflowUser } from "@/lib/workflow-http";
import { workflowMutationSchema } from "@/lib/validation/workflow";

type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, context: Context) {
  try {
    const user = await workflowUser(), { id } = await context.params;
    const [item, events] = await Promise.all([getWorkflowRecord(user, id), getWorkflowEvents(user, id)]);
    return workflowJson({ ...item, events });
  } catch (error) { return workflowFailure(error); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const user = await workflowUser(request), { id } = await context.params;
    const parsed = workflowMutationSchema.safeParse(await readWorkflowBody(request));
    if (!parsed.success) return workflowJson({ error: parsed.error.issues[0]?.message ?? "Проверьте поля формы" }, 400);
    await mutateWorkflowRecord(user, id, parsed.data);
    return workflowJson(await getWorkflowRecord(user, id));
  } catch (error) { return workflowFailure(error); }
}
