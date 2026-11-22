import { NextResponse } from "next/server";
import { getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { getStorageMode, isDatabaseAvailable } from "@/lib/db";
import { unavailableStorageResponse } from "@/lib/runtime-storage-policy";
import {
  createInformationRequestSchema,
  mockInformationRequests,
} from "@/lib/information-requests";
import {
  createInformationRequest,
  listInformationRequests,
  presentRequestFor,
  RequestError,
} from "@/lib/information-requests-models";
export async function GET() {
  const user = await getSessionUser();
  if (!user || user.role === "guest")
    return NextResponse.json(
      { error: "Войдите в аккаунт для просмотра запросов" },
      { status: 401 }
    );
  const mode = await getStorageMode();
  if (mode === "read-only") return unavailableStorageResponse();
  if (mode !== "dynamodb")
    return NextResponse.json(
      { items: mockInformationRequests, dbAvailable: false },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  try {
    return NextResponse.json(
      { items: await listInformationRequests(user), dbAvailable: true },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch {
    return NextResponse.json(
      { error: "Не удалось загрузить запросы" },
      { status: 503 }
    );
  }
}
export async function POST(request: Request) {
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
  const parsed = createInformationRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success)
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Проверьте поля" },
      { status: 400 }
    );
  try {
    return NextResponse.json(
      await presentRequestFor(user, await createInformationRequest(user, parsed.data)),
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof RequestError
            ? error.message
            : "Не удалось отправить запрос",
      },
      { status: error instanceof RequestError ? error.status : 503 }
    );
  }
}
