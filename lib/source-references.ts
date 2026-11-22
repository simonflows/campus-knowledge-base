import { z } from "zod";

export const sourceVersionSchema = z.strictObject({
  cardId: z.string().min(1).max(200),
  versionId: z.string().min(1).max(200),
});
export const sourceVersionsSchema = z.array(sourceVersionSchema).max(100);
export type SourceVersionReference = z.infer<typeof sourceVersionSchema>;
