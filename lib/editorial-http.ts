import { NextResponse } from "next/server";
import { EditorialError } from "./editorial";
export function editorialErrorResponse(error: unknown) {
  if (error instanceof EditorialError)
    return NextResponse.json(
      { error: error.message },
      { status: error.status, headers: { "Cache-Control": "no-store" } }
    );
  console.error(
    "Editorial operation failed",
    error instanceof Error ? error.name : "unknown"
  );
  return NextResponse.json(
    {
      error:
        "Не удалось выполнить действие. Ваш текст остаётся на устройстве до успешного сохранения.",
    },
    { status: 503 }
  );
}
export const privateHeaders = { "Cache-Control": "private, no-store" };
