import { z } from "zod";

const id = z.string().trim().min(1).max(200);

export const articleBasisRequestSchema = z.strictObject({
  articleId: id,
  revisionId: id,
  chunkIds: z
    .array(id)
    .min(1)
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length),
});

export const articleBasisReferencesSchema = z
  .array(
    z.strictObject({
      articleId: id,
      revisionId: id,
      sectionId: id,
      chunkId: id,
      articleTitle: z.string().min(1).max(500),
      sectionHeading: z.string().max(300),
    })
  )
  .max(10)
  .refine(
    (references) =>
      new Set(
        references.map(({ articleId, revisionId, chunkId }) =>
          JSON.stringify([articleId, revisionId, chunkId])
        )
      ).size === references.length
  );
