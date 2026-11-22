import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth-server";
import { editorialErrorResponse, privateHeaders } from "@/lib/editorial-http";
import { getCardVersionId } from "@/lib/knowledge-versions";
import { getCanonicalKnowledgeCards } from "@/lib/models";

export async function GET() {
  const user = await getSessionUser();
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
