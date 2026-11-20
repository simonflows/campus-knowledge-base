import { z } from "zod";
import { editorialContentSchema, type EditorialContent } from "./editorial";
import { RECOVERY_PREFIX } from "./editorial-session-cleanup";
export { RECOVERY_PREFIX, clearEditorialRecovery } from "./editorial-session-cleanup";
const recoverySchema = z.object({
  ownerId: z.string(),
  documentId: z.string().nullable(),
  version: z.number().int().nonnegative(),
  savedAt: z.number(),
  content: editorialContentSchema,
});
export type EditorialRecovery = z.infer<typeof recoverySchema>;
export function readEditorialRecovery(ownerId: string): EditorialRecovery[] {
  try {
    const values: EditorialRecovery[] = [];
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(RECOVERY_PREFIX)) continue;
      const parsed = recoverySchema.safeParse(
        JSON.parse(localStorage.getItem(key) || "null")
      );
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
    localStorage.setItem(
      `${RECOVERY_PREFIX}${ownerId}:${documentId || "new"}`,
      JSON.stringify({
        ownerId,
        documentId,
        version,
        savedAt: Date.now(),
        content,
      })
    );
    const mine = readEditorialRecovery(ownerId);
    for (const old of mine.slice(8))
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
