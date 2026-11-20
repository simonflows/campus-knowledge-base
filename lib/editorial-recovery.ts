import { z } from "zod";
import { editorialContentSchema, type EditorialContent } from "./editorial";
import { RECOVERY_PREFIX } from "./editorial-session-cleanup";
export { RECOVERY_PREFIX, clearEditorialRecovery } from "./editorial-session-cleanup";

// Keep locally typed text even when its length prevents a server save.
const recoverableText = z.string().default("");
const recoveryContentSchema = z.object({
  ...editorialContentSchema.shape,
  title: recoverableText,
  lead: recoverableText,
  query: recoverableText,
  topic: recoverableText,
  audience: recoverableText,
  outlet: recoverableText,
  length: recoverableText,
  projectTitle: recoverableText,
  sourceCardIds: z.array(z.string().min(1)).default([]),
  sourceCardTitles: z.array(z.string()).default([]),
  sections: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        heading: z.string(),
        level: z.union([z.literal(2), z.literal(3)]),
        chunks: z
          .array(z.object({ id: z.string().min(1).max(100), content: z.string() }))
          .max(12),
      })
    )
    .max(20)
    .default([]),
});
const recoverySchema = z.object({
  ownerId: z.string(),
  documentId: z.string().nullable(),
  version: z.number().int().nonnegative(),
  savedAt: z.number(),
  content: recoveryContentSchema,
});
export type EditorialRecovery = z.infer<typeof recoverySchema>;
export function readEditorialRecovery(ownerId: string): EditorialRecovery[] {
  try {
    const values: EditorialRecovery[] = [];
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(RECOVERY_PREFIX)) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        continue;
      }
      const parsed = recoverySchema.safeParse(value);
      if (
        !parsed.success ||
        Date.now() - parsed.data.savedAt > 7 * 24 * 60 * 60 * 1000
      ) {
        localStorage.removeItem(key);
        continue;
      }
      if (parsed.data.ownerId === ownerId) values.push(parsed.data);
    }
    return values.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}
export function saveEditorialRecovery(
  ownerId: string,
  documentId: string | null,
  version: number,
  content: EditorialContent
) {
  try {
    const record = { ownerId, documentId, version, savedAt: Date.now(), content };
    if (!recoverySchema.safeParse(record).success) return false;

    localStorage.setItem(
      `${RECOVERY_PREFIX}${ownerId}:${documentId || "new"}`,
      JSON.stringify(record)
    );
    const previous = readEditorialRecovery(ownerId).filter(
      (copy) => copy.documentId !== documentId
    );
    for (const old of previous.slice(7))
      removeEditorialRecovery(ownerId, old.documentId);
    return true;
  } catch {
    return false;
  }
}
export function removeEditorialRecovery(
  ownerId: string,
  documentId: string | null
) {
  try {
    localStorage.removeItem(
      `${RECOVERY_PREFIX}${ownerId}:${documentId || "new"}`
    );
  } catch {}
}
