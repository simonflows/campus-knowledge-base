"use client";
import { WorkspaceMasthead } from "@/components/workspace-masthead";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  KeyRound,
  LockKeyhole,
  LogOut,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  demoAccountsByRole,
  roleDefinitions,
  roleLabels,
  roleShortLabels,
  type Role,
  type SessionUser,
} from "@/lib/auth";
import "@/app/campus-workspaces.css";

const demoGroups = demoAccountsByRole();

type LoginScreenProps = {
  currentUser: SessionUser | null;
  demo: boolean;
};

export function LoginScreen({ currentUser, demo }: LoginScreenProps) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pinForAdmin, setPinForAdmin] = useState("");
  const [showPinInput, setShowPinInput] = useState(false);
  const [login, setLogin] = useState("");
  const [key, setKey] = useState("");
  const [activeRole, setActiveRole] = useState<Role>(
    currentUser?.role ?? "university_owner"
  );

  const handleLogin = async (accountId: string, pin?: string) => {
    setBusyId(accountId);

    try {
      const response = await fetch("/api/auth/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId,
          ...(pin ? { pin } : {}),
          ...(!demo ? { accessKey: key } : {}),
        }),
      });
      const data = (await response.json().catch(() => null)) as {
        user?: SessionUser;
        error?: string;
        requiresPin?: boolean;
      } | null;

      if (data?.requiresPin) {
        setShowPinInput(true);
        toast.error(data.error ?? "Введите ПИН-код администратора");
        return;
      }

      if (!response.ok || !data?.user) {
        toast.error(data?.error ?? "Не удалось войти под аккаунтом");
        return;
      }

      if (currentUser && currentUser.id !== data.user.id) {
        const { clearEditorialRecovery } =
          await import("@/lib/editorial-recovery");
        clearEditorialRecovery();
      }
      setKey("");
      toast.success(`Вы вошли как ${data.user.name}`, {
        description: roleLabels[data.user.role],
      });
      router.refresh();
      router.push("/knowledge");
    } catch {
      toast.error("Ошибка сети при входе");
    } finally {
      setBusyId(null);
    }
  };

  const handleLogout = async () => {
    setBusyId("logout");

    try {
      const response = await fetch("/api/auth/session", { method: "DELETE" });
      if (!response.ok) throw new Error("Logout failed");
      const { clearEditorialRecovery } =
        await import("@/lib/editorial-recovery");
      clearEditorialRecovery();
      toast.success("Сессия завершена");
      router.refresh();
    } catch {
      toast.error("Не удалось завершить сессию");
    } finally {
      setBusyId(null);
    }
  };

  const group =
    demoGroups.find(({ role }) => role === activeRole) ?? demoGroups[0];
  const definition = roleDefinitions[group.role];

  return (
    <div className="atlas-wrap campus-workspace">
      <section className="desk-access" aria-labelledby="access-title">
        <WorkspaceMasthead
          access
          id="access-title"
          icon={LockKeyhole}
          title="Вход в справочник кампуса"
          description={
            demo
              ? "Выберите демонстрационный аккаунт, чтобы посмотреть права доступа каждой роли."
              : "Логин и персональный ключ выдаёт координатор кампуса."
          }
        >
          <Link href="/knowledge" className="desk-text-link">
            <ArrowLeft size={16} aria-hidden="true" /> К базе знаний
          </Link>
        </WorkspaceMasthead>
        <div className="desk-access-body">
          {currentUser ? (
            <div className="desk-active-account">
              <span className="desk-icon" aria-hidden="true">
                <UserRound />
              </span>
              <div>
                <h2>{currentUser.name}</h2>
                <p className="desk-footnote">
                  {roleLabels[currentUser.role]} · {currentUser.organization}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={handleLogout}
                disabled={!!busyId}
              >
                <LogOut /> Выйти
              </Button>
            </div>
          ) : null}
          {!demo && !currentUser ? (
            <div className="desk-credentials">
              <div>
                <p className="desk-kicker">
                  <ShieldCheck size={15} /> Доступ сотрудников
                </p>
                <h2>Вход по ключу</h2>
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleLogin(login.trim());
                }}
              >
                <Field>
                  <FieldLabel htmlFor="pilot-login">Логин</FieldLabel>
                  <Input
                    id="pilot-login"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    required
                    maxLength={64}
                    value={login}
                    onChange={(event) => setLogin(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="pilot-key">Персональный ключ</FieldLabel>
                  <Input
                    id="pilot-key"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={100}
                    value={key}
                    onChange={(event) => setKey(event.target.value)}
                  />
                </Field>
                <Button type="submit" disabled={!!busyId}>
                  {busyId ? "Входим…" : "Войти"}
                  <ArrowRight data-icon="inline-end" />
                </Button>
              </form>
            </div>
          ) : null}
          {demo ? (
            <section aria-labelledby="demo-accounts">
              <div className="desk-access-selection">
                <div>
                  <p className="desk-kicker">
                    <KeyRound size={14} /> Демонстрационный доступ
                  </p>
                  <h2 id="demo-accounts">Аккаунты</h2>
                </div>
                <Field>
                  <FieldLabel htmlFor="demo-role">Роль</FieldLabel>
                  <select
                    id="demo-role"
                    value={activeRole}
                    disabled={!!busyId}
                    onChange={(event) => {
                      setActiveRole(event.target.value as Role);
                      setPinForAdmin("");
                      setShowPinInput(false);
                    }}
                  >
                    {demoGroups.map(({ role }) => (
                      <option key={role} value={role}>
                        {roleShortLabels[role]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div key={group.role} className="desk-role-panel desk-panel-in">
                <details className="desk-disclosure desk-role-permissions">
                  <summary>
                    <ShieldCheck size={17} /> Права роли
                    <ChevronDown className="desk-chevron" size={16} />
                  </summary>
                  <p>{definition.description}</p>
                  <ul>
                    {definition.capabilities.map((item) => (
                      <li key={item}>
                        <Check size={14} /> {item}
                      </li>
                    ))}
                    {definition.restrictions.map((item) => (
                      <li key={item}>
                        <LockKeyhole size={14} /> {item}
                      </li>
                    ))}
                  </ul>
                </details>
                <ul className="desk-account-list">
                  {group.accounts.map((account) => {
                    const isCurrent = currentUser?.id === account.id;
                    const needsPinInput =
                      account.role === "admin" && showPinInput;

                    return (
                      <li className="desk-account-row" key={account.id}>
                        <div className="desk-account-main">
                          <span className="desk-icon" aria-hidden="true">
                            <UserRound />
                          </span>
                          <div>
                            <strong>{account.name}</strong>
                            <p className="desk-footnote">
                              {account.position.includes(account.organization)
                                ? account.position
                                : `${account.position} · ${account.organization}`}
                            </p>
                          </div>
                        </div>
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            void handleLogin(
                              account.id,
                              account.role === "admin" ? pinForAdmin : undefined
                            );
                          }}
                        >
                          {needsPinInput ? (
                            <Field>
                              <FieldLabel htmlFor="admin-access-pin">
                                ПИН-код администратора
                              </FieldLabel>
                              <Input
                                id="admin-access-pin"
                                type="password"
                                autoComplete="off"
                                required
                                value={pinForAdmin}
                                onChange={(event) =>
                                  setPinForAdmin(event.target.value)
                                }
                              />
                              <FieldDescription>
                                ПИН-код выдаёт координатор.
                              </FieldDescription>
                            </Field>
                          ) : null}
                          <Button
                            type="submit"
                            variant="outline"
                            aria-label={
                              isCurrent
                                ? "Текущий аккаунт"
                                : `Войти под ролью: ${account.name}`
                            }
                            disabled={busyId !== null || isCurrent}
                          >
                            {isCurrent
                              ? "Текущий аккаунт"
                              : busyId === account.id
                                ? "Входим…"
                                : "Войти"}
                            {!isCurrent ? (
                              <ArrowRight data-icon="inline-end" />
                            ) : null}
                          </Button>
                        </form>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </section>
          ) : null}
        </div>
      </section>
    </div>
  );
}
