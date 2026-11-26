import { NextResponse } from "next/server";
import { getSessionUser, verifySameOrigin } from "./auth-server";
import { WorkflowError } from "./workflow";
import { canUseStaffWorkflow } from "./auth";

export async function workflowUser(request?: Request) {
  if (request && !verifySameOrigin(request)) throw new WorkflowError("Недопустимый источник запроса", 403);
  const user = await getSessionUser();
  if (!user) throw new WorkflowError("Войдите в аккаунт", 401);
  if (!canUseStaffWorkflow(user)) throw new WorkflowError("Эта работа доступна сотрудникам", 403);
  return user;
}
export function workflowJson(value: unknown, status = 200) {
  return NextResponse.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}
export function workflowFailure(error: unknown) {
  if (error instanceof WorkflowError) return workflowJson({ error: error.message }, error.status);
  if (error instanceof Error && "status" in error && [403, 404, 409].includes(Number(error.status)))
    return workflowJson({ error: error.message }, Number(error.status));
  return workflowJson({ error: "Общая база временно недоступна. Введённые данные сохранены в форме." }, 503);
}
export async function readWorkflowBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new WorkflowError("Нужны данные формы");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 100_000) { await reader.cancel(); throw new WorkflowError("Объём формы превышает 100 КБ", 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw new WorkflowError("Проверьте формат данных формы");
  }
}
