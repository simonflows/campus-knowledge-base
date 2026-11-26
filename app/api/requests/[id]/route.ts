import { NextResponse } from "next/server";
import { staffDirectory } from "@/lib/account-directory";
import { canUseStaffWorkflow } from "@/lib/auth";
import { verifySameOrigin } from "@/lib/auth-server";
import { readRouteSession } from "@/lib/account-route-session";
import { getStorageMode } from "@/lib/db";
import { canSeeInformationRequest, updateInformationRequestSchema } from "@/lib/information-requests";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import {
  mutateInformationRequest,
  getInformationRequest,
  presentRequestFor,
  RequestError,
} from "@/lib/information-requests-models";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await readRouteSession();
  if (session.response) return session.response;
  const { user } = session;
  if (!user) return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  if (!canUseStaffWorkflow(user))
    return NextResponse.json({ error: "Запросы доступны сотрудникам" }, { status: 403 });
  if (await getStorageMode() !== "dynamodb") return unavailableStorageResponse();
  try {
    const item = await getInformationRequest((await params).id);
    if (!item || !canSeeInformationRequest(user, item)) return NextResponse.json({ error: "Запрос не найден" }, { status: 404 });
    const directory = await staffDirectory();
    const people = directory.filter(person => person.universityId === item.recipientUniversityId && ["university_pr", "university_owner"].includes(person.role)).map(person => ({ id: person.id, name: person.name }));
    const participants = (item.participantIds ?? [item.authorId]).map(id => ({ id, name: directory.find(person => person.id === id)?.name ?? "Учётная запись недоступна" }));
    return NextResponse.json({ item: await presentRequestFor(user, item), people, participants }, { headers: { "Cache-Control": "private, no-store" } });
  } catch { return NextResponse.json({ error: "Не удалось загрузить сведения запроса" }, { status: 503 }); }
}
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!verifySameOrigin(request))
    return NextResponse.json(
      { error: "Недопустимый источник запроса" },
      { status: 403 }
    );
  const session = await readRouteSession();
  if (session.response) return session.response;
  const { user } = session;
  if (!user)
    return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401 });
  if (!canUseStaffWorkflow(user))
    return NextResponse.json({ error: "Запросы доступны сотрудникам" }, { status: 403 });
  if (await getStorageMode() !== "dynamodb") return unavailableStorageResponse();
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
