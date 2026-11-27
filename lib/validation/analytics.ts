import { z } from "zod";

import {
  officialDocumentDataSchema,
  strategyEvidenceSchema,
} from "../strategy";

export const analyticsQuerySchema = z.object({
  query: z
    .string()
    .trim()
    .min(3, "Опишите запрос к базе хотя бы тремя символами")
    .max(500, "Запрос слишком длинный: сократите его до 500 символов"),
  flashAssist: z.boolean().optional(),
  useAi: z.boolean().optional(),
});

export type AnalyticsQueryInput = z.infer<typeof analyticsQuerySchema>;

export const strategyAnalyticsQuerySchema = z.strictObject({
  mode: z.literal("strategy"),
  documentId: strategyEvidenceSchema.shape.document.shape.cardId,
  documentVersionId: strategyEvidenceSchema.shape.document.shape.versionId,
  target: z
    .strictObject({
      kind: z.enum(["clause", "direction"]),
      id: officialDocumentDataSchema.shape.clauses.element.shape.id,
    })
    .optional(),
});

export type StrategyAnalyticsQuery = z.infer<
  typeof strategyAnalyticsQuerySchema
>;

export const analyticsRequestSchema = z.discriminatedUnion("mode", [
  analyticsQuerySchema.extend({ mode: z.literal("text").optional() }),
  strategyAnalyticsQuerySchema,
]);
