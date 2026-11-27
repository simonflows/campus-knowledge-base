import { NextResponse } from "next/server";

import { getAllKnowledgeCards } from "@/lib/models";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import { strategyOptionsForCards } from "@/lib/strategy-server";

export async function GET(request: Request) {
  try {
    const cards = await getAllKnowledgeCards(request.signal);
    return NextResponse.json(strategyOptionsForCards(cards), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return unavailableStorageResponse();
  }
}
