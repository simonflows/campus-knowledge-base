import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/auth-server";
import { findCampusServices } from "@/lib/campus-services";
import { findHomeCards } from "@/lib/home-card-search";
import { getAllKnowledgeCards } from "@/lib/models";

const querySchema = z.string().trim().max(1000);
const headers = { "Cache-Control": "private, no-store" };

export async function GET(request: NextRequest) {
  const parsed = querySchema.safeParse(
    request.nextUrl.searchParams.get("q") ?? ""
  );
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Сократите запрос до 1000 символов." },
      { status: 400, headers }
    );
  }
  const query = parsed.data;
  const services = findCampusServices(query);
  if (!query) return NextResponse.json({ services, cards: [] }, { headers });
  try {
    const [cards, user] = await Promise.all([
      getAllKnowledgeCards(),
      getSessionUser(),
    ]);
    return NextResponse.json(
      { services, cards: findHomeCards(cards, query, user) },
      { headers }
    );
  } catch {
    return NextResponse.json(
      { services, error: "Не удалось загрузить карточки." },
      { status: 503, headers }
    );
  }
}
