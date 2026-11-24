import { z } from "zod";
import type { CanonChatAnswer } from "@/lib/canon-ai";

const productRoutes = new Set([
  "/knowledge",
  "/editor",
  "/check",
  "/analytics",
  "/login",
]);

export function safeAssistantHref(href: string) {
  if (!href.startsWith("/") || href.startsWith("//") || href.includes("\\"))
    return null;
  try {
    const url = new URL(href, "https://canon.invalid");
    if (
      url.origin !== "https://canon.invalid" ||
      !productRoutes.has(url.pathname)
    )
      return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

const answerSchema = z.object({
  status: z.enum([
    "ready",
    "local",
    "unavailable",
    "busy",
    "failed",
    "too-long",
  ]),
  message: z.string().max(8000),
  presentation: z.literal("summary").optional(),
  citations: z
    .array(
      z.object({
        sourceId: z.string().max(120),
        factId: z.string().max(120),
        quote: z.string().min(1).max(1200),
        cardId: z.string().max(200),
        versionId: z.string().max(200),
        title: z.string().max(500),
        href: z.string().max(1500),
        field: z.string().max(500),
        label: z.string().max(500),
      })
    )
    .max(6),
  actions: z
    .array(
      z.object({
        label: z.string().max(240),
        href: z.string().max(1500),
      })
    )
    .max(6),
});

export function parseAssistantAnswer(input: unknown): CanonChatAnswer | null {
  const parsed = answerSchema.safeParse(input);
  if (!parsed.success) return null;
  const citations = parsed.data.citations.flatMap((citation) => {
    const href = safeAssistantHref(citation.href);
    const expected = `/knowledge?card=${encodeURIComponent(citation.cardId)}&version=${encodeURIComponent(citation.versionId)}`;
    return href === expected ? [{ ...citation, href }] : [];
  });
  const actions = parsed.data.actions.flatMap((action) => {
    const href = safeAssistantHref(action.href);
    return href ? [{ ...action, href }] : [];
  });
  return { ...parsed.data, citations, actions };
}
