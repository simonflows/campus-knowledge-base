import { NextResponse } from "next/server";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { isDatabaseAvailable } from "@/lib/db";
import { updateInformationRequestSchema } from "@/lib/information-requests";
import {
  mutateInformationRequest,
  presentRequestFor,
  RequestError,
} from "@/lib/information-requests-models";
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!verifySameOrigin(request))
    return NextResponse.json(
      { error: "Недопустимый источник запроса" },
      { status: 403 }
    );
  const user = await getSessionUser();
  if (!user)
    return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  if (!(await isDatabaseAvailable()))
    return NextResponse.json(
      { error: "База данных временно недоступна" },
      { status: 503 }
    );
  const parsed = updateInformationRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Проверьте поля" },
      { status: 400 }
    );
  try {
    const { id } = await params;
    return NextResponse.json(
      await presentRequestFor(user, await mutateInformationRequest(user, id, parsed.data))
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof RequestError
            ? error.message
            : "Не удалось сохранить ответ",
      },
      { status: error instanceof RequestError ? error.status : 503 }
    );
  }
}
