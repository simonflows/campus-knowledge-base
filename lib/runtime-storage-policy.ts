import { getStorageMode } from "./db";

export const storageUnavailableMessage =
  "Общая база временно недоступна. Попробуйте обновить страницу позже.";

export async function getReadableStorageMode() {
  const mode = await getStorageMode();
  if (mode === "read-only") throw new Error(storageUnavailableMessage);
  return mode;
}

export function unavailableStorageResponse() {
  return Response.json(
    { error: storageUnavailableMessage },
    { status: 503, headers: { "Cache-Control": "private, no-store" } }
  );
}
