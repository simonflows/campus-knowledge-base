import { readRouteSession } from "@/lib/account-route-session";
import { NextResponse } from "next/server";
import { verifySameOrigin } from "@/lib/auth-server";
import { editorialErrorResponse, privateHeaders } from "@/lib/editorial-http";
import { editorialReadinessMutationSchema, getEditorialReadiness, updateEditorialReadiness } from "@/lib/editorial-readiness";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  const session = await readRouteSession();
  if (session.response) return session.response;
  const { user } = session;
  if (!user) return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  try {
    return NextResponse.json(await getEditorialReadiness(user, (await context.params).id), { headers: privateHeaders });
  } catch (error) {
    return editorialErrorResponse(error);
  }
}

export async function POST(request: Request, context: Context) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json({ error: "Запрещён кросс-доменный запрос" }, { status: 403 });
  }
  const session = await readRouteSession();
  if (session.response) return session.response;
  const { user } = session;
  if (!user) return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  const input = editorialReadinessMutationSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "Проверьте данные редакции и источников" }, { status: 400 });
  try {
    return NextResponse.json(await updateEditorialReadiness(user, (await context.params).id, input.data), { headers: privateHeaders });
  } catch (error) {
    return editorialErrorResponse(error);
  }
}
