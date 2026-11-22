import { getWorkData } from "@/lib/work-data";
import { workflowFailure, workflowJson, workflowUser } from "@/lib/workflow-http";

export async function GET() {
  try { return workflowJson(await getWorkData(await workflowUser())); }
  catch (error) { return workflowFailure(error); }
}
