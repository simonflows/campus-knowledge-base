import { NextResponse } from "next/server";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { assistEditorial, editorAssistInputSchema } from "@/lib/editor-assist";
import { editorialErrorResponse, privateHeaders } from "@/lib/editorial-http";
import { demoLoginEnabled } from "@/lib/pilot-auth";

export async function POST(request: Request) {
  if (!verifySameOrigin(request)) {
    return NextResponse.json({ error: "Запрещён кросс-доменный запрос" }, { status: 403 });
  }
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  if (user.role === "guest" || demoLoginEnabled()) {
    return NextResponse.json({ error: "Подсказки Flash доступны сотрудникам" }, { status: 403 });
  }
  const input = editorAssistInputSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return NextResponse.json({ error: "Проверьте параметры редакции" }, { status: 400 });
  try {
    return NextResponse.json(await assistEditorial(user, input.data, request), { headers: privateHeaders });
  } catch (error) {
    return editorialErrorResponse(error);
  }
}
