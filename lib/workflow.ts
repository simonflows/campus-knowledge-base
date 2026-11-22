import { createHash } from "node:crypto";
import { z } from "zod";
import type { SessionUser } from "./auth";
import type { SourceVersionReference } from "./source-references";
import { disputeEvidenceSchema, type CreateWorkflowInput, type WorkflowMutation } from "./validation/workflow";
import { applyWorkflowMutation as applyMutation, makeWorkflowRecord as makeRecord } from "./workflow-policy";
export { createWorkflowSchema, workflowMutationSchema } from "./validation/workflow";
export type { CreateWorkflowInput, WorkflowMutation } from "./validation/workflow";
type WorkflowBase = {
  id: string; title: string; description: string; creatorId: string; creatorName: string;
  responsibleId: string; participantIds: string[]; dueDate: string | null;
  createdAt: string; updatedAt: string; version: number; creationDigest: string;
  lastOperationId: string; lastOperationDigest: string;
};
export type NewsPackage = WorkflowBase & { kind: "package"; sources: SourceVersionReference[]; documentIds: string[] };
export type SourceDispute = WorkflowBase & { kind: "dispute"; cardId: string | null; evidence: z.infer<typeof disputeEvidenceSchema>[]; status: "open" | "resolved"; decision: string | null };
export type WorkflowRecord = NewsPackage | SourceDispute;
export type WorkflowEvent = { id: string; kind: "workflow-event"; recordId: string; actorId: string; actorName: string; at: string; action: string; message: string; version: number };
export { WorkflowError, canReadWorkflow, canEditWorkflow } from "./workflow-policy";
export function workflowDigest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function makeWorkflowRecord(user: SessionUser, input: CreateWorkflowInput, people: SessionUser[], now = new Date().toISOString()): WorkflowRecord {
  return makeRecord(user, input, people, workflowDigest, now);
}

export function applyWorkflowMutation(user: SessionUser, record: WorkflowRecord, input: WorkflowMutation, people: SessionUser[]): WorkflowRecord {
  return applyMutation(user, record, input, people, workflowDigest);
}
