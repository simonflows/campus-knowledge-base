import { z } from "zod";

const count = z.number().int().min(0).max(100_000);
const text = z.string().max(60_000);
const level = z.enum(["red", "yellow", "green"]);
const checkpoint = z.enum([
  "campus",
  "placement",
  "authorship",
  "contour",
  "names",
  "figures",
]);
const verdict = z.enum([
  "supported",
  "contradicted",
  "unknown",
  "opinion",
  "outside",
]);
const summary = z.object({
  red: count,
  yellow: count,
  green: count,
  total: count,
});
const citation = z.object({
  sourceId: text,
  factId: text,
  quote: text,
  cardId: text,
  versionId: text,
  title: text,
  href: text,
  field: text,
  label: text,
});
const counts = z.object({ total: count, completed: count });
const ai = z
  .object({
    status: z.enum([
      "ready",
      "local",
      "unavailable",
      "busy",
      "failed",
      "too-long",
    ]),
    claims: z
      .array(
        z.object({
          id: z.number().int(),
          quote: text,
          start: count,
          end: count,
          verdict,
          explanation: text,
          correction: text,
          evidence: z.array(citation).max(100),
        })
      )
      .max(5000)
      .optional(),
    citations: z.array(citation).max(5000).optional(),
    mode: z.enum(["semantic", "mixed"]).optional(),
    reviewedSpans: count.optional(),
    totalSpans: count.optional(),
    classifiedSpans: count.optional(),
    rejectedClaims: count.optional(),
    ignoredAnnotations: count.optional(),
    message: text.optional(),
    reason: text.optional(),
    verification: counts.optional(),
    batches: z
      .object({
        total: count,
        attempted: count,
        completed: count,
        failed: count,
        deadlineReached: z.boolean(),
      })
      .optional(),
  })
  .refine((value) => value.status !== "ready" || Array.isArray(value.claims));
const rewrite = z.object({
  title: text,
  lead: text,
  plainText: text,
  sections: z.array(
    z.object({
      id: text,
      heading: text,
      level: z.union([z.literal(2), z.literal(3)]),
      chunks: z.array(z.object({ id: text, content: text })),
    })
  ),
  sourceCardIds: z.array(text),
  sourceCardTitles: z.array(text),
  preservedText: text.optional(),
  changes: z
    .array(z.object({ before: text, after: text, sourceCardId: text }))
    .optional(),
  sourceVersions: z.record(z.string(), z.string()).optional(),
});

const finding = z.object({
  id: text,
  level,
  checkpoint,
  checkpointLabel: text,
  title: text,
  quote: text,
  explanation: text,
  suggestion: text,
  sourceCardId: text.nullable(),
  sourceCardTitle: text.nullable(),
  sourceFolder: text.nullable(),
  sourceVersionId: text.optional(),
  sourceField: text.optional(),
  sourceUrl: text.nullish(),
  quoteStart: count.optional(),
  quoteEnd: count.optional(),
  replacement: text.optional(),
});

/** Validate fields consumed by the report before rendering either wire format. */
export const factCheckResultSchema = z.object({
  checkedChars: z.number().int().min(0).max(60_000),
  canPublish: z.boolean(),
  coverage: z.enum(["confirmed", "partial", "unverified"]),
  summary,
  findings: z.array(finding).max(5000),
  checkpoints: z
    .array(
      z.object({
        key: checkpoint,
        label: text,
        red: count,
        yellow: count,
        green: count,
      })
    )
    .max(100),
  claimCoverage: z
    .object({
      mode: z.enum(["limited", "semantic", "mixed"]),
      supported: count,
      contradicted: count,
      unknown: count,
      opinion: count,
      outside: count,
      semanticReviewed: count.optional(),
      spanCount: count.optional(),
    })
    .optional(),
  claims: z
    .array(z.object({ id: text, quote: text, verdict }))
    .max(5000)
    .optional(),
  ai: ai.optional(),
  rewrite: rewrite.nullish(),
  rewriteCheck: z
    .object({
      summary,
      canPublish: z.boolean(),
      isClean: z.boolean(),
      findings: z.array(finding).max(5000).optional(),
    })
    .nullish(),
  rewriteAi: z
    .object({
      status: z.enum([
        "ready",
        "local",
        "unchanged",
        "unavailable",
        "busy",
        "failed",
        "too-long",
      ]),
      citations: z.array(citation).max(5000).optional(),
    })
    .refine(
      (value) => value.status !== "ready" || Array.isArray(value.citations)
    )
    .optional(),
  rewriteError: text.optional(),
});
