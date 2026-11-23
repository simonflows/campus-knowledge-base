"use client";

import {
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import { FlaskConical, LogOut, RotateCcw } from "lucide-react";
import { CampusChrome } from "@/components/navigation/campus-chrome";
import { DemoNavigationContext } from "@/components/navigation/workspace-navigation";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { demoAccounts, roleShortLabels } from "@/lib/auth";
import {
  BROWSER_DEMO_KEY,
  demoUser,
  getDemoError,
  readBrowserDemo,
  resetBrowserDemo,
  selectDemoProfile,
  writeBrowserDemo,
} from "@/lib/browser-demo";
import {
  demoIncomingRequestCount,
  handleDemoCollaboration,
} from "@/lib/browser-demo-collaboration";
import { handleDemoEditor } from "@/lib/browser-demo-editor";
import {
  createBrowserDemoRequest,
  demoError,
  queueDemoWrite,
} from "@/lib/browser-demo-http";
import { handleDemoKnowledge } from "@/lib/browser-demo-knowledge";
import { handleDemoTools } from "@/lib/browser-demo-tools";
import { useDemoLocation } from "./demo-location";
import { DemoPageContent } from "./demo-page-content";
import { DemoRequestContext } from "./workspace-transport";

const handlers = [
  handleDemoKnowledge,
  handleDemoEditor,
  handleDemoTools,
  handleDemoCollaboration,
];
const localStatus = {
  storageMode: "browser",
  yandexAi: { configured: false },
  yandexDisk: { configured: false },
  alibabaAi: { configured: false },
};
const demoStorage = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) =>
    window.localStorage.setItem(key, value),
};
const hydratedSubscribe = () => () => {};
const hydratedSnapshot = () => true;
const serverSnapshot = () => false;
const unavailableRequest = async () =>
  demoError("Не удалось открыть данные демо в браузере.", 409);

function readLocalState() {
  try {
    return { state: readBrowserDemo(demoStorage), error: null };
  } catch (error) {
    return { state: null, error: getDemoError(error) };
  }
}

function ExitDemo({ href }: { href: string }) {
  return (
    <a
      className={buttonVariants({
        variant: "outline",
        className: "atlas-account atlas-login atlas-demo-exit",
      })}
      href={href}
    >
      <LogOut data-icon="inline-start" aria-hidden="true" />
      <span>Выйти из демо</span>
    </a>
  );
}

export function BrowserDemo({ exitHref }: { exitHref: string }) {
  const hydrated = useSyncExternalStore(
    hydratedSubscribe,
    hydratedSnapshot,
    serverSnapshot
  );
  if (hydrated) return <DemoSession exitHref={exitHref} />;
  return (
    <main id="main-content" className="atlas-wrap my-8 space-y-4">
      <h1 className="text-2xl font-semibold">Демо-режим</h1>
      <p role="status">Открываем учебные данные в браузере…</p>
      <ExitDemo href={exitHref} />
    </main>
  );
}

function DemoSession({ exitHref }: { exitHref: string }) {
  const navigation = useDemoLocation();
  const [stored, setStored] = useState(readLocalState);
  const [resetOpen, setResetOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const { profile, epoch } = stored.state ?? {};
  const request = useMemo(
    () =>
      profile && epoch
        ? createBrowserDemoRequest(
            demoStorage,
            { profile, epoch },
            handlers,
            (state) => setStored({ state, error: null })
          )
        : unavailableRequest,
    [profile, epoch]
  );

  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key === BROWSER_DEMO_KEY || event.key === null)
        setStored(readLocalState());
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  async function changeProfile(profile: string) {
    setBusy(true);
    try {
      const state = await queueDemoWrite(demoStorage, () => {
        const next = selectDemoProfile(readBrowserDemo(demoStorage), profile);
        writeBrowserDemo(demoStorage, next);
        return next;
      });
      setStored({ state, error: null });
      setNotice("");
    } catch (error) {
      setNotice(getDemoError(error));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      const state = await queueDemoWrite(demoStorage, () =>
        resetBrowserDemo(demoStorage)
      );
      setStored({ state, error: null });
      setNotice("Учебные примеры восстановлены.");
      navigation.navigate("/", { replace: true });
    } catch (error) {
      setNotice(getDemoError(error));
    } finally {
      setBusy(false);
      setResetOpen(false);
    }
  }

  const state = stored.state;
  const user = state ? demoUser(state) : null;
  const account = state && (
    <DemoProfile profile={state.profile} busy={busy} change={changeProfile} />
  );
  const banner = (
    <div className="atlas-mode border-b-2! border-amber-500! bg-amber-100! text-slate-950!">
      <div className="wrap atlas-wrap flex flex-wrap items-center justify-between gap-x-5 gap-y-2 py-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <FlaskConical size={16} aria-hidden="true" />
          <strong>Демо-режим</strong>
          <span>
            Учебные данные. Изменения сохраняются в этом браузере. ИИ
            имитируется, выгрузка на Диск отключена.
          </span>
        </div>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          {account}
          <Dialog open={resetOpen} onOpenChange={setResetOpen}>
            <DialogTrigger
              render={<Button variant="outline" size="sm" type="button" />}
            >
              <RotateCcw aria-hidden="true" />
              Сбросить демо
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Восстановить учебные примеры?</DialogTitle>
                <DialogDescription>
                  Все изменения демо, сделанные в этом браузере, будут удалены.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose
                  render={<Button variant="outline" type="button" />}
                  disabled={busy}
                >
                  Отмена
                </DialogClose>
                <Button
                  type="button"
                  onClick={() => void reset()}
                  disabled={busy}
                >
                  Сбросить изменения
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        {notice && (
          <p className="basis-full font-medium" role="status">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
  return (
    <DemoNavigationContext.Provider value={navigation}>
      <DemoRequestContext.Provider value={request}>
        <CampusChrome
          key={`${profile ?? "unavailable"}:${epoch ?? ""}`}
          staff={Boolean(user && user.role !== "guest")}
          status={{
            ...localStatus,
            incomingRequests: state ? demoIncomingRequestCount(state) : 0,
          }}
          demo
          account={
            <div className="atlas-demo-controls">
              <span
                className="rounded-full bg-amber-100 px-2 py-1 text-xs font-semibold text-slate-950"
                aria-label="Демо-режим"
              >
                Демо
              </span>
              <ExitDemo href={exitHref} />
            </div>
          }
          banner={banner}
        >
          {state ? (
            <DemoPageContent
              state={state}
              location={navigation.location}
              account={account}
            />
          ) : (
            <p className="atlas-wrap py-8 text-destructive" role="alert">
              {stored.error}
            </p>
          )}
        </CampusChrome>
      </DemoRequestContext.Provider>
    </DemoNavigationContext.Provider>
  );
}

function DemoProfile({
  profile,
  change,
  busy,
}: {
  profile: string;
  change(profile: string): Promise<void>;
  busy: boolean;
}) {
  const id = useId();
  return (
    <div className="min-w-0 max-w-full">
      <label className="sr-only" htmlFor={id}>
        Учебная роль
      </label>
      <select
        className="h-9 max-w-full rounded-md border bg-background px-2 text-xs"
        id={id}
        value={profile}
        disabled={busy}
        onChange={(event) => void change(event.target.value)}
      >
        {demoAccounts.map((account) => (
          <option key={account.id} value={account.id}>
            {roleShortLabels[account.role]} · {account.organization}
          </option>
        ))}
      </select>
    </div>
  );
}
