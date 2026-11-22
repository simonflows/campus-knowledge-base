import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { deleteEditorialSchema, editorialMutationSchema } from "@/lib/editorial";
import {
  deleteEditorial,
  getEditorialWithRevisions,
  mutateEditorial,
  getEditorialReviewers,
} from "@/lib/editorial-models";
import { editorialErrorResponse, privateHeaders } from "@/lib/editorial-http";
import { syncArticleRecord } from "@/lib/disk-sync-service";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: NextRequest, context: Context) {
  const user = await getSessionUser();
  if (!user)
    return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  try {
    const { document, revisions } = await getEditorialWithRevisions(
      (await context.params).id,
      user
    );
    return NextResponse.json(
      {
        document,
        revisions,
        reviewers:
          document.ownerId === user.id ? await getEditorialReviewers(document) : [],
      },
      { headers: privateHeaders }
    );
  } catch (error) {
    return editorialErrorResponse(error);
  }
}
export async function DELETE(request: NextRequest, context: Context) {
  if (!verifySameOrigin(request))
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );
  const user = await getSessionUser();
  if (!user)
    return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  const parsed = deleteEditorialSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: "Укажите версию черновика" }, { status: 400 });
  try {
    await deleteEditorial((await context.params).id, user, parsed.data.version);
    return NextResponse.json({ success: true }, { headers: privateHeaders });
  } catch (error) {
    return editorialErrorResponse(error);
  }
}
export async function PATCH(request: NextRequest, context: Context) {
  if (!verifySameOrigin(request))
    return NextResponse.json(
      { error: "Запрещён кросс-доменный запрос" },
      { status: 403 }
    );
  const user = await getSessionUser();
  if (!user)
    return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  const parsed = editorialMutationSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: "Проверьте действие", details: parsed.error.flatten() },
      { status: 400 }
    );
  try {
    const result = await mutateEditorial(
      (await context.params).id,
      user,
      parsed.data
    );
    if (result.publication) {
      result.publication = await syncArticleRecord(result.publication).catch(
        () => result.publication!
      );
    }
    return NextResponse.json(result, { headers: privateHeaders });
  } catch (error) {
    return editorialErrorResponse(error);
  }
}
