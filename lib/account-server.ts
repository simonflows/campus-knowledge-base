import { after, NextResponse } from "next/server";
import { accountMailboxReady, sendAccountEmail } from "./account-email";
import { emailAccountsEnabled } from "./account-directory";
import { AccountError, createAccountService } from "./account-service";
import { dynamoAccountStore } from "./account-storage";

export const accountService = createAccountService(
  dynamoAccountStore,
  () => Math.floor(Date.now() / 1000),
  async (message) => {
    // Only the recipient receives the proof. Failed delivery is reported uniformly.
    after(async () => {
      try {
        await sendAccountEmail(message);
      } catch {
        console.error("Не удалось отправить письмо авторизации.");
      }
    });
  },
);

export function requireEmailAccounts() {
  if (!emailAccountsEnabled() || (process.env.SESSION_SECRET?.length ?? 0) < 32) throw new AccountError("Вход по электронной почте временно недоступен.", 503);
}

export async function requireAccountMailbox() {
  if (!(await accountMailboxReady())) throw new AccountError("Отправка писем временно недоступна. Повторите позже.", 503, 20);
}

export function accountJson(value: unknown, status = 200, retryAfter?: number) {
  return NextResponse.json(value, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      ...(retryAfter == null ? {} : { "Retry-After": String(retryAfter) }),
    },
  });
}

export function accountFailure(error: unknown) {
  if (error instanceof AccountError) return accountJson({ error: error.message }, error.status, error.retryAfter);
  console.error("Ошибка обработки авторизации.");
  return accountJson({ error: "Авторизация временно недоступна." }, 503);
}

export async function readAccountBody(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    throw new AccountError("Нужны данные формы в формате JSON.", 400);
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError("Нужны данные формы.", 400);

  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      size += value.byteLength;
      if (size > 4096) {
        void reader.cancel().catch(() => undefined);
        throw new AccountError("Объём формы превышает 4 КБ.", 413);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AccountError) throw error;
    throw new AccountError("Проверьте данные формы.", 400);
  }
}
