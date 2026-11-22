export const RECOVERY_PREFIX = "campus-editor-recovery:";
export const EDITORIAL_SESSION_ENDED = "campus-session-ended";
export const EDITORIAL_SESSION_END_KEY = "campus-editor-session-end";

function clearCopies(storage: Storage) {
  for (const key of Object.keys(storage)) {
    if (key.startsWith(RECOVERY_PREFIX)) storage.removeItem(key);
  }
}

export function editorialRecoveryStorage(): Storage {
  const storage = sessionStorage;
  let lastSessionEnd: string | null;
  try {
    lastSessionEnd = localStorage.getItem(EDITORIAL_SESSION_END_KEY);
  } catch {
    return storage;
  }
  if (storage.getItem(EDITORIAL_SESSION_END_KEY) !== lastSessionEnd) {
    clearCopies(storage);
    if (lastSessionEnd === null) storage.removeItem(EDITORIAL_SESSION_END_KEY);
    else storage.setItem(EDITORIAL_SESSION_END_KEY, lastSessionEnd);
  }
  return storage;
}

export function clearEditorialRecovery() {
  try {
    clearCopies(localStorage);
  } catch {}
  try {
    clearCopies(sessionStorage);
  } catch {}
  try {
    const marker = crypto.getRandomValues(new Uint32Array(2)).join("-");
    localStorage.setItem(EDITORIAL_SESSION_END_KEY, marker);
  } catch {}
  window.dispatchEvent(new Event(EDITORIAL_SESSION_ENDED));
}
