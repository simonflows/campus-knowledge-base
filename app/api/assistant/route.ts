import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifySameOrigin } from "@/lib/auth-server";
import { readRouteSession } from "@/lib/account-route-session";
import { answerWebChat } from "@/lib/assistant-web";
import { answerCanonChat } from "@/lib/canon-ai";
import { getCardVersionId } from "@/lib/knowledge-versions";
import { getCanonicalKnowledgeCards } from "@/lib/models";
import { demoLoginEnabled } from "@/lib/pilot-auth";
import { JsonBodyError, readBoundedJson } from "@/lib/http-json";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";

const inputSchema = z.strictObject({
  mode: z.enum(["canon", "web"]).default("canon"),
  message: z.string().trim().min(2, "Напишите вопрос").max(2000),
  history: z.array(z.string().trim().max(2000)).max(4).default([]),
});
const headers = { "Cache-Control": "private, no-store" };

export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request)) return NextResponse.json({ error: "Запрещён кросс-доменный запрос" }, { status: 403, headers });
  let body: unknown;
  try { body = await readBoundedJson(request, 24 * 1024); }
  catch (error) { return NextResponse.json({ error: error instanceof JsonBodyError ? error.message : "Не удалось прочитать запрос" }, { status: error instanceof JsonBodyError ? error.status : 400, headers }); }
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Сократите вопрос до 2000 знаков и повторите отправку" }, { status: 400, headers });
  const session = await readRouteSession();
  if (session.response) return session.response;
  const user = session.user;
  const accountId = user && user.role !== "guest" && !demoLoginEnabled() ? user.id : null;
  if (parsed.data.mode === "web") {
    if (!accountId) return NextResponse.json({ error: "Войдите в аккаунт для поиска в интернете" }, { status: user ? 403 : 401, headers });
    return NextResponse.json(await answerWebChat({ request, accountId, question: parsed.data.message }), { headers });
  }
  const cards = await getCanonicalKnowledgeCards().catch(() => null);
  if (!cards) return unavailableStorageResponse();
  const answer = await answerCanonChat({ request, accountId, question: parsed.data.message, history: parsed.data.history, cards });
  if (answer.status === "ready" && answer.citations.length) {
    const current = await getCanonicalKnowledgeCards().catch(() => null);
    if (!current) return unavailableStorageResponse();
    if (answer.citations.some(citation => !current.some(card => card.id === citation.cardId && getCardVersionId(card) === citation.versionId))) {
      return NextResponse.json({ status: "failed", message: "Карточки изменились во время ответа. Повторите вопрос, чтобы использовать актуальную версию.", citations: [], actions: [] }, { headers });
    }
  }
  return NextResponse.json(answer, { headers });
}
