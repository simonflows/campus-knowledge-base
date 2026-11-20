export const RECOVERY_PREFIX = "campus-editor-recovery:";

export function clearEditorialRecovery() {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith(RECOVERY_PREFIX)) localStorage.removeItem(key);
  } catch {}
  window.dispatchEvent(new Event("campus-session-ended"));
}
