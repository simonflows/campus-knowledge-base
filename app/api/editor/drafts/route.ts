import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { createEditorialSchema } from "@/lib/editorial";
import {
  createEditorial,
  listEditorial,
  listLegacyArticles,
} from "@/lib/editorial-models";
import { editorialErrorResponse, privateHeaders } from "@/lib/editorial-http";
export async function GET() {
  const user = await getSessionUser();
  if (!user)
    return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  try {
    return NextResponse.json(
      {
        documents: await listEditorial(user),
        legacyArticles: await listLegacyArticles(user),
      },
      { headers: privateHeaders }
    );
  } catch (error) {
    return editorialErrorResponse(error);
  }
}
export async function POST(request: NextRequest) {
  if (!verifySameOrigin(request))
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );
  const user = await getSessionUser();
  if (!user)
    return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  const parsed = createEditorialSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: "Проверьте данные черновика", details: parsed.error.flatten() },
      { status: 400 }
    );
  try {
    return NextResponse.json(await createEditorial(user, parsed.data), {
      status: 201,
      headers: privateHeaders,
    });
  } catch (error) {
    return editorialErrorResponse(error);
  }
}
