import { z } from "zod";
import { sourceVersionSchema } from "../source-references";

const id = z.string().min(1).max(200);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "Укажите существующую календарную дату");
const commonInput = {
  operationId: z.uuid(), title: z.string().trim().min(3).max(180),
  description: z.string().trim().max(4000).default(""),
  responsibleId: id, participantIds: z.array(id).max(60).default([]),
  dueDate: day.nullable().default(null),
};
export const disputeEvidenceSchema = z.strictObject({
  statement: z.string().trim().min(3).max(4000), object: z.string().trim().min(1).max(500),
  year: z.number().int().min(1900).max(2200).nullable(), unit: z.string().max(100),
  state: z.enum(["actual", "plan", "unknown"]), url: z.url().max(2000).refine(v => v.startsWith("https://")),
});
export const createWorkflowSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...commonInput, kind: z.literal("package"), sources: z.array(sourceVersionSchema).max(100).default([]), documentIds: z.array(id).max(100).default([]) }),
  z.strictObject({ ...commonInput, kind: z.literal("dispute"), cardId: id.nullable().default(null), evidence: z.array(disputeEvidenceSchema).length(2) }),
]);
const mutationBase = { operationId: z.uuid(), version: z.number().int().positive() };
export const workflowMutationSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...mutationBase, action: z.literal("edit"), title: z.string().trim().min(3).max(180).optional(), description: z.string().trim().max(4000).optional(), responsibleId: id.optional(), participantIds: z.array(id).max(60).optional(), dueDate: day.nullable().optional() }),
  z.strictObject({ ...mutationBase, action: z.literal("add-source"), source: sourceVersionSchema }),
  z.strictObject({ ...mutationBase, action: z.literal("remove-source"), source: sourceVersionSchema }),
  z.strictObject({ ...mutationBase, action: z.literal("add-document"), documentId: id }),
  z.strictObject({ ...mutationBase, action: z.literal("remove-document"), documentId: id }),
  z.strictObject({ ...mutationBase, action: z.literal("resolve"), decision: z.string().trim().min(10).max(4000) }),
  z.strictObject({ ...mutationBase, action: z.literal("reopen"), reason: z.string().trim().min(10).max(4000) }),
]);
export type CreateWorkflowInput = z.infer<typeof createWorkflowSchema>;
export type WorkflowMutation = z.infer<typeof workflowMutationSchema>;
