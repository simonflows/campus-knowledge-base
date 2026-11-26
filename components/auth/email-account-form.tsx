"use client";

import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Mail, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { accountActionSchema, emailLoginSchema, type StaffGrant } from "@/lib/account-validation";
import { roleLabels, type SessionUser } from "@/lib/auth";
import { universities } from "@/lib/data";
import { clearEditorialRecovery } from "@/lib/editorial-session-cleanup";

const subscribeToHydration = () => () => undefined;

export function useAuthFormHydrated() {
  return useSyncExternalStore(subscribeToHydration, () => true, () => false);
}

export type AccountMode = "login" | "signup" | "forgot" | "verify" | "reset";

const titles: Record<AccountMode, string> = {
  login: "Вход по почте",
  signup: "Создать аккаунт автора",
  forgot: "Восстановить пароль",
  verify: "Завершить регистрацию",
  reset: "Задать новый пароль",
};

export function EmailAccountForm({
  initialMode,
  basePath,
  returnTo,
  currentUserId,
}: {
  initialMode: AccountMode;
  basePath: string;
  returnTo: string;
  currentUserId?: string;
}) {
  const router = useRouter();
  const hydrated = useAuthFormHydrated();
  const passwordInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState(initialMode);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const proof = mode === "verify" || mode === "reset";
  const usePassword = proof || mode === "login";

  const switchMode = (next: AccountMode) => {
    setError("");
    setNotice("");
    setMode(next);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || busy) return;
    const formData = new FormData(event.currentTarget);
    const email = formData.get("email");
    const password = passwordInput.current?.value;
    const token = window.location.hash.slice(1);
    const parsed = mode === "login"
      ? emailLoginSchema.safeParse({ method: "email", email, password })
      : accountActionSchema.safeParse(
          mode === "verify" ? { action: mode, token, name: formData.get("name"), password } :
          mode === "reset" ? { action: mode, token, password } : { action: mode, email },
        );
    setNotice("");
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setError("");
    setBusy(true);
    try {
      const endpoint = mode === "login" ? "/session" : "/account";
      const response = await fetch(basePath + "/api/auth" + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const result: { error?: string; user?: SessionUser } | null = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error ?? "Не удалось выполнить действие. Повторите позже.");
      if (mode === "login" && result?.user) {
        if (currentUserId && currentUserId !== result.user.id) clearEditorialRecovery();
        const destination = result.user.role === "author" && ["/requests", "/work"].includes(returnTo) ? "/knowledge" : returnTo;
        router.replace(destination);
        router.refresh();
      } else if (proof) {
        window.history.replaceState(window.history.state, "", window.location.pathname);
        setMode("login");
        setNotice(mode === "verify" ? "Почта подтверждена. Войдите с новым паролем." : "Пароль обновлён. Войдите с новым паролем.");
        router.refresh();
      } else {
        setNotice("Если для этого адреса доступно действие, письмо придёт в ближайшее время. Проверьте папку «Спам».");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Не удалось выполнить действие.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="desk-credentials" aria-labelledby="email-account-title">
      <div>
        <p className="desk-kicker"><Mail size={15} aria-hidden="true" /> Аккаунт автора</p>
        <h2 id="email-account-title">{titles[mode]}</h2>
        {mode === "signup" && <p className="desk-footnote">Подтвердите адрес, чтобы сохранять личные черновики и пользоваться инструментами редактора.</p>}
      </div>
      <form key={mode} method="post" onSubmit={submit}>
        {!proof && <Field>
          <FieldLabel htmlFor="account-email">Электронная почта</FieldLabel>
          <Input id="account-email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={254} required />
        </Field>}
        {mode === "verify" && <Field>
          <FieldLabel htmlFor="account-name">Ваше имя</FieldLabel>
          <Input id="account-name" name="name" autoComplete="name" minLength={2} maxLength={120} required />
        </Field>}
        {usePassword && <Field>
          <FieldLabel htmlFor="account-password">Пароль</FieldLabel>
          <Input
            id="account-password" type="password" ref={passwordInput}
            autoComplete={proof ? "new-password" : "current-password"}
            aria-describedby={proof ? "account-password-hint" : undefined}
            minLength={proof ? 15 : undefined} maxLength={128} required
          />
          {proof && <FieldDescription id="account-password-hint">Не менее 15 символов.</FieldDescription>}
        </Field>}
        <Button type="submit" disabled={!hydrated || busy}>
          {busy ? "Подождите…" : mode === "login" ? "Войти" : proof ? "Сохранить пароль" : "Отправить письмо"} <ArrowRight aria-hidden="true" />
        </Button>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        {notice && <p className="text-sm" role="status">{notice}</p>}
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {mode !== "signup" && <Button type="button" variant="link" className="px-0" onClick={() => switchMode("signup")} disabled={busy}>Регистрация</Button>}
          {mode !== "forgot" && <Button type="button" variant="link" className="px-0" onClick={() => switchMode("forgot")} disabled={busy}>Забыли пароль</Button>}
          {mode !== "login" && <Button type="button" variant="link" className="px-0" onClick={() => switchMode("login")} disabled={busy}>Ко входу</Button>}
        </div>
      </form>
    </section>
  );
}

const grantRoles = ["author", "university_owner", "university_pr", "ministry", "rio", "chkk"] as const;
type SelectedAccount = {
  id: string;
  name: string;
  email?: string;
  provider: "password" | "yandex";
  grant: StaffGrant;
  revision: number;
};

export function AccountRoleForm({ basePath }: { basePath: string }) {
  const hydrated = useAuthFormHydrated();
  const [account, setAccount] = useState<SelectedAccount>();
  const [role, setRole] = useState("");
  const [universityId, setUniversityId] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string }>();
  const universityRole = role === "university_owner" || role === "university_pr";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!hydrated || busy) return;
    const parsed = accountActionSchema.safeParse(account ? {
      action: "grant", accountId: account.id, revision: account.revision,
      grant: { role, ...(universityRole ? { universityId } : {}) },
    } : {
      action: "lookup", accountId: new FormData(event.currentTarget).get("accountId"),
    });
    if (!parsed.success) {
      setFeedback({ kind: "error", message: parsed.error.issues[0].message });
      return;
    }
    setBusy(true);
    setFeedback(undefined);
    try {
      const response = await fetch(basePath + "/api/auth/account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      const data: { account?: SelectedAccount; user?: SessionUser; error?: string } | null = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409) setAccount(undefined);
        throw new Error(data?.error ?? "Не удалось проверить аккаунт или сохранить роль.");
      }
      if (data?.account) {
        setAccount(data.account);
        setRole("");
        setUniversityId("");
      } else if (data?.user) {
        setAccount(undefined);
        setFeedback({ kind: "success", message: "Роль для " + data.user.name + " сохранена. Пользователю нужно войти снова." });
      }
    } catch (failure) {
      setFeedback({ kind: "error", message: failure instanceof Error ? failure.message : "Не удалось назначить роль." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="desk-credentials" aria-labelledby="account-grant-title">
      <div>
        <p className="desk-kicker"><ShieldCheck size={15} aria-hidden="true" /> Доступ сотрудников</p>
        <h2 id="account-grant-title">Назначить роль</h2>
        <p className="desk-footnote">Сверьте полномочия и попросите сотрудника прислать код аккаунта со страницы входа.</p>
      </div>
      <form method="post" onSubmit={submit}>
        {account ? (
          <>
            <div className="text-sm break-words">
              <p className="font-medium">{account.name}</p>
              <p>{account.provider === "yandex" ? "Вход через Яндекс" : "Вход по электронной почте"} · {roleLabels[account.grant.role]}</p>
              {account.email && <p>Контактная почта {account.email}</p>}
              <p>Код <code className="break-all">{account.id}</code></p>
            </div>
            <Field>
              <FieldLabel htmlFor="account-grant-role">Новая роль</FieldLabel>
              <Select value={role || null} onValueChange={value => setRole(value ?? "")}>
                <SelectTrigger id="account-grant-role"><SelectValue placeholder="Выберите роль" /></SelectTrigger>
                <SelectContent>
                  {grantRoles.map(value => <SelectItem key={value} value={value}>{roleLabels[value]}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            {universityRole && <Field>
              <FieldLabel htmlFor="account-grant-university">Университет</FieldLabel>
              <Select value={universityId || null} onValueChange={value => setUniversityId(value ?? "")}>
                <SelectTrigger id="account-grant-university"><SelectValue placeholder="Выберите вуз" /></SelectTrigger>
                <SelectContent>
                  {universities.map(university => <SelectItem key={university.id} value={university.id}>{university.shortName}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>}
            <Button type="submit" variant="outline" disabled={!hydrated || busy || !role || (universityRole && !universityId)}>
              {busy ? "Сохраняем…" : "Сохранить роль"}
            </Button>
            <Button type="button" variant="link" className="px-0" disabled={busy} onClick={() => { setAccount(undefined); setFeedback(undefined); }}>Выбрать другой аккаунт</Button>
          </>
        ) : (
          <>
            <Field>
              <FieldLabel htmlFor="account-grant-id">Код аккаунта</FieldLabel>
              <Input id="account-grant-id" name="accountId" autoCapitalize="none" spellCheck={false} maxLength={43} required />
            </Field>
            <Button type="submit" variant="outline" disabled={!hydrated || busy}>
              {busy ? "Проверяем…" : "Найти аккаунт"}
            </Button>
          </>
        )}
        {feedback && <p className={feedback.kind === "error" ? "text-sm text-destructive" : "text-sm"} role={feedback.kind === "error" ? "alert" : "status"}>{feedback.message}</p>}
      </form>
    </section>
  );
}
