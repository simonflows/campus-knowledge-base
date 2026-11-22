"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Database,
  KeyRound,
  Menu,
  Home,
  XCircle,
} from "lucide-react";

import { MobileNav } from "@/components/navigation/header-nav";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

import type { getIntegrationStatus } from "@/lib/integration-status";

type SystemStatusPayload = ReturnType<typeof getIntegrationStatus> & {
  storageMode: string;
  incomingRequests?: number;
};

const isDemoMode = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

function StatusPill({
  configured,
  label,
}: {
  configured: boolean;
  label: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1",
        configured
          ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
          : "bg-amber-50 text-amber-800 ring-amber-200"
      )}
    >
      {configured ? (
        <CheckCircle2 className="size-3 shrink-0" />
      ) : (
        <XCircle className="size-3 shrink-0" />
      )}
      {label}
    </span>
  );
}

type SystemStatusBarProps = {
  showIntegrationStatus: boolean;
  initialStatus: SystemStatusPayload;
  staff?: boolean;
};

export function SystemStatusBar(props: SystemStatusBarProps) {
  const pathname = usePathname();
  return <SystemStatusControls key={pathname} {...props} />;
}

function SystemStatusControls({
  showIntegrationStatus,
  initialStatus: status,
  staff,
}: SystemStatusBarProps) {
  const [statusOpen, setStatusOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 80rem)");
    function closeOnDesktop(event: MediaQueryListEvent) {
      if (event.matches) setMobileMenuOpen(false);
    }
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);

  const activeCount = [
    status.yandexAi.configured,
    status.yandexDisk.configured,
    status.alibabaAi.configured,
  ].filter(Boolean).length;

  return (
    <>
      <div className="flex items-center gap-1.5">
        {isDemoMode && showIntegrationStatus ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setStatusOpen(true)}
            className="h-10 gap-1.5 rounded-full border-border/80 bg-card/90 px-2.5 text-[11px] font-medium text-foreground/85 hover:bg-muted"
            title="Состояние облачных интеграций"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                activeCount === 0
                  ? "bg-muted-foreground"
                  : activeCount === 3
                    ? "bg-emerald-600"
                    : "bg-amber-600"
              )}
              aria-hidden="true"
            />
            <span className="sr-only md:hidden">
              Интеграции {activeCount}/3
            </span>
            <span className="hidden md:inline">Интеграции</span>
            <span className="hidden xl:inline text-muted-foreground">
              · {activeCount}/3
            </span>
            <KeyRound className="h-3 w-3 md:ml-0.5 text-primary" />
          </Button>
        ) : null}

        <Dialog open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
          <DialogTrigger
            render={<Button type="button" variant="ghost" size="icon-sm" />}
            className="size-10 xl:hidden"
            aria-label="Открыть меню навигации"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </DialogTrigger>
          <DialogContent className="atlas-mobile-menu max-h-[90vh] overflow-y-auto sm:max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 font-heading">
                <Home className="h-4 w-4" aria-hidden="true" />
                Навигация по сервису
              </DialogTitle>
              <DialogDescription>
                Официальные данные кампуса «Южный Урал»
              </DialogDescription>
            </DialogHeader>
            <MobileNav
              incomingCount={status.incomingRequests}
              staff={staff}
              onNavigate={() => setMobileMenuOpen(false)}
            />
            {isDemoMode && showIntegrationStatus ? (
              <>
                <Separator />
                <Button
                  type="button"
                  variant="outline"
                  className="w-full justify-start gap-2"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    setStatusOpen(true);
                  }}
                >
                  <KeyRound className="h-4 w-4 text-primary" />
                  Интеграции ({activeCount}/3)
                </Button>
              </>
            ) : null}
          </DialogContent>
        </Dialog>
      </div>

      {isDemoMode && showIntegrationStatus ? (
        <Dialog open={statusOpen} onOpenChange={setStatusOpen}>
          <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>Состояние интеграций</DialogTitle>
              <DialogDescription>
                Чтобы подключить сервис, передайте оператору имена переменных из
                списка ниже. Оператор задаёт значения в защищённой форме
                VibeCraft или в хранилище секретов сервера.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap gap-2">
              <StatusPill
                configured={status.yandexAi.configured}
                label={
                  status.yandexAi.configured
                    ? "Yandex AI Studio настроен"
                    : "Yandex AI: Демо-движок"
                }
              />
              <StatusPill
                configured={status.yandexDisk.configured}
                label={
                  status.yandexDisk.configured
                    ? "Яндекс Диск настроен"
                    : "Яндекс Диск: Ожидает токен"
                }
              />
              <StatusPill
                configured={status.alibabaAi.configured}
                label={
                  status.alibabaAi.configured
                    ? "Alibaba Qwen настроен"
                    : "Alibaba Cloud: Демо-режим"
                }
              />
            </div>

            <Badge variant="outline" className="gap-1">
              <Database aria-hidden="true" />
              {status.storageMode === "dynamodb"
                ? "DynamoDB / YDB"
                : status.storageMode === "local-json"
                  ? "Локальное демо"
                  : "Общая база недоступна"}
            </Badge>
            <dl className="grid gap-3 text-sm">
              <div>
                <dt className="font-medium">Yandex AI Studio</dt>
                <dd className="break-words">
                  <code>YANDEX_AI_STUDIO_API_KEY</code> и{" "}
                  <code>YANDEX_AI_STUDIO_FOLDER_ID</code>
                </dd>
              </div>
              <div>
                <dt className="font-medium">Яндекс Диск</dt>
                <dd className="break-words">
                  <code>YANDEX_DISK_OAUTH_TOKEN</code>
                </dd>
              </div>
              <div>
                <dt className="font-medium">Alibaba Qwen</dt>
                <dd className="break-words">
                  <code>ALIBABA_DASHSCOPE_API_KEY</code>
                </dd>
              </div>
            </dl>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setStatusOpen(false)}
              >
                Закрыть
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
