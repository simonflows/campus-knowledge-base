import { findCardUsage } from "@/lib/card-usage";
import { workflowFailure, workflowJson, workflowUser } from "@/lib/workflow-http";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try { return workflowJson({ items: await findCardUsage(await workflowUser(), (await context.params).id) }); }
  catch (error) { return workflowFailure(error); }
}
