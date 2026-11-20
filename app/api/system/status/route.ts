import { NextResponse } from "next/server";

import { getStorageMode } from "@/lib/db";
import { getIntegrationStatus } from "@/lib/integration-status";

export async function GET() {
  return NextResponse.json(
    {
      storageMode: await getStorageMode(),
      ...getIntegrationStatus(),
      timestamp: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export function POST(_request: Request) {
  return NextResponse.json(
    {
      error:
        "Интеграции настраивает оператор через защищённую форму VibeCraft или серверное хранилище секретов.",
    },
    { status: 403 }
  );
}
