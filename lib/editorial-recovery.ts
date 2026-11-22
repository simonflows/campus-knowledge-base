import { z } from "zod";
import { editorialContentSchema, type EditorialContent } from "./editorial";
import { editorialRecoveryStorage, RECOVERY_PREFIX } from "./editorial-session-cleanup";
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
const tabRecoverySchema = recoverySchema.extend({ expiresAt: z.number() });
const TAB_LIFETIME = 8 * 60 * 60 * 1000;
const LEGACY_LIFETIME = 7 * 24 * 60 * 60 * 1000;
export type EditorialRecovery = z.infer<typeof recoverySchema>;

const ownerPrefix = (ownerId: string) => `${RECOVERY_PREFIX}${ownerId}:`;
const recoveryKey = (ownerId: string, documentId: string | null) =>
  `${ownerPrefix(ownerId)}${documentId || "new"}`;

function parseStoredValue(storage: Storage, key: string): unknown {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readTabCopy(storage: Storage, key: string, now: number) {
  const parsed = tabRecoverySchema.safeParse(parseStoredValue(storage, key));
  if (parsed.success) {
    const { expiresAt, ...record } = parsed.data;
    if (now < expiresAt) return record;
  }
  storage.removeItem(key);
  return null;
}

export function migrateEditorialRecovery(ownerId: string) {
  try {
    const storage = editorialRecoveryStorage();
    const now = Date.now();
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(ownerPrefix(ownerId))) continue;
      const legacy = recoverySchema.safeParse(parseStoredValue(localStorage, key));
      if (
        !legacy.success ||
        legacy.data.ownerId !== ownerId ||
        recoveryKey(ownerId, legacy.data.documentId) !== key
      ) continue;
      if (now - legacy.data.savedAt >= LEGACY_LIFETIME) {
        localStorage.removeItem(key);
        continue;
      }
      const existing = readTabCopy(storage, key, now);
      if (existing) {
        if (existing.version !== legacy.data.version ||
          JSON.stringify(existing.content) !== JSON.stringify(legacy.data.content)
        ) continue;
      } else {
        storage.setItem(key, JSON.stringify({ ...legacy.data, expiresAt: now + TAB_LIFETIME }));
      }
      localStorage.removeItem(key);
    }
  } catch {
    // Keep any copies that could not be transferred to the current tab.
  }
}

export function readEditorialRecovery(ownerId: string): EditorialRecovery[] {
  try {
    const storage = editorialRecoveryStorage();
    const now = Date.now();
    const values: EditorialRecovery[] = [];
    for (const key of Object.keys(storage)) {
      if (!key.startsWith(ownerPrefix(ownerId))) continue;
      const copy = readTabCopy(storage, key, now);
      if (copy?.ownerId === ownerId && recoveryKey(ownerId, copy.documentId) === key) {
        values.push(copy);
      }
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
    const storage = editorialRecoveryStorage();
    const savedAt = Date.now();
    const record = { ownerId, documentId, version, savedAt, expiresAt: savedAt + TAB_LIFETIME, content };
    if (!tabRecoverySchema.safeParse(record).success) return false;
    storage.setItem(
      recoveryKey(ownerId, documentId),
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
    editorialRecoveryStorage().removeItem(recoveryKey(ownerId, documentId));
  } catch {}
}
