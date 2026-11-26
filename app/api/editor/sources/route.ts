import { NextResponse } from "next/server";
import { readRouteSession } from "@/lib/account-route-session";
import { editorialErrorResponse, privateHeaders } from "@/lib/editorial-http";
import { getCardVersionId } from "@/lib/knowledge-versions";
import { getCanonicalKnowledgeCards } from "@/lib/models";

export async function GET() {
  const session = await readRouteSession();
  if (session.response) return session.response;
  const user = session.user;
  if (!user || user.role === "guest") {
    return NextResponse.json({ error: "Источники редактора доступны сотрудникам" }, { status: user ? 403 : 401 });
  }
  try {
    const cards = await getCanonicalKnowledgeCards();
    return NextResponse.json(cards.map((card) => ({
      id: card.id,
      title: card.title,
      versionId: getCardVersionId(card),
    })), { headers: privateHeaders });
  } catch (error) {
    return editorialErrorResponse(error);
  }
}
