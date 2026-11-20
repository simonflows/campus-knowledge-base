"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogIn, LogOut, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { roleShortLabels, type SessionUser } from "@/lib/auth";
import { clearEditorialRecovery } from "@/lib/editorial-session-cleanup";

type UserMenuProps = {
  initialUser: SessionUser | null;
};

export function UserMenu({ initialUser }: UserMenuProps) {
  const router = useRouter();
  const accountCurrent = usePathname() === "/login" ? "page" : undefined;
  const [isBusy, setIsBusy] = useState(false);

  const handleLogout = async () => {
    setIsBusy(true);

    try {
      const response = await fetch("/api/auth/session", { method: "DELETE" });
      if (!response.ok) throw new Error("Logout failed");
      clearEditorialRecovery();
      toast.success("Вы вышли из аккаунта");
      router.refresh();
      router.push("/login");
    } catch {
      toast.error("Не удалось завершить сессию");
    } finally {
      setIsBusy(false);
    }
  };

  if (!initialUser) {
    return (
      <Link
        href="/login"
        className={buttonVariants({
          className: "atlas-account atlas-login",
          size: "sm",
        })}
        aria-current={accountCurrent}
      >
        <LogIn className="h-4 w-4" aria-hidden="true" />
        <span>Войти</span>
      </Link>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Link
        href="/login"
        aria-current={accountCurrent}
        className="atlas-account hidden items-center gap-2 border py-1 pr-1 pl-3 text-left transition-colors sm:flex"
      >
        <span className="flex flex-col">
          <span className="text-xs font-semibold leading-tight">
            {initialUser.name}
          </span>
          <span className="text-[10px] text-muted-foreground">
            {roleShortLabels[initialUser.role]}
          </span>
        </span>
        <Badge variant="secondary" className="gap-1">
          <ShieldCheck className="h-3 w-3" />
          {initialUser.organization}
        </Badge>
      </Link>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={handleLogout}
        disabled={isBusy}
        aria-label="Выйти из аккаунта"
      >
        <LogOut className="h-4 w-4" />
      </Button>
    </div>
  );
}
