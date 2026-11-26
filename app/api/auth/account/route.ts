import { setTimeout as delay } from "node:timers/promises";
import { getClientIp, getSessionUser, verifySameOrigin } from "@/lib/auth-server";
import { accountFailure, accountJson, accountService, readAccountBody, requireAccountMailbox, requireEmailAccounts } from "@/lib/account-server";
import { accountActionSchema } from "@/lib/account-validation";
import { enabledAccountProviders } from "@/lib/account-directory";

export async function POST(request: Request) {
  if (!verifySameOrigin(request)) return accountJson({ error: "Недопустимый источник запроса." }, 403);
  try {
    const parsed = accountActionSchema.safeParse(await readAccountBody(request));
    if (!parsed.success) return accountJson({ error: parsed.error.issues[0]?.message ?? "Проверьте данные формы." }, 400);
    const action = parsed.data;
    const ip = getClientIp(request);
    if (action.action === "grant" || action.action === "lookup") {
      if (!enabledAccountProviders().length) return accountJson({ error: "Управление аккаунтами временно недоступно." }, 503);
      const actor = await getSessionUser();
      if (!actor) return accountJson({ error: "Войдите в аккаунт." }, 401);
      if (action.action === "lookup") return accountJson({ account: await accountService.findForGrant(actor, action.accountId, ip) });
      const user = await accountService.grantRoleById(actor, action.accountId, action.revision, action.grant, ip);
      return accountJson({ user });
    }
    requireEmailAccounts();
    if (action.action === "signup" || action.action === "forgot") {
      const startedAt = Date.now();
      await requireAccountMailbox();
      if (action.action === "signup") await accountService.startSignup(action.email, ip);
      else await accountService.startReset(action.email, ip);
      // Preserve the same response timing for no-op and issued email proofs.
      const remaining = 300 - (Date.now() - startedAt);
      if (remaining > 0) await delay(remaining, undefined, { signal: request.signal });
      return accountJson({ accepted: true }, 202);
    }
    if (action.action === "verify") await accountService.finishSignup(action.token, action, ip);
    else if (action.action === "reset") await accountService.finishReset(action.token, action.password, ip);
    return accountJson({ ok: true });
  } catch (error) {
    return accountFailure(error);
  }
}
