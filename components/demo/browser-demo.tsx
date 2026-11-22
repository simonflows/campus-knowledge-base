"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { FlaskConical, RotateCcw } from "lucide-react";

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
import { WorkspaceMasthead } from "@/components/workspace-masthead";
import { demoAccounts, roleShortLabels } from "@/lib/auth";
import {
  approvedDemoCards,
  BROWSER_DEMO_KEY,
  type BrowserDemoState,
  getDemoError,
  readBrowserDemo,
  resetBrowserDemo,
  selectDemoProfile,
  writeBrowserDemo,
} from "@/lib/browser-demo";

import { DemoCards } from "./demo-cards";
import { DemoEditor, DemoLibrary } from "./demo-editor";
import { DemoAnalytics, DemoChat, DemoFactCheck } from "./demo-tools";

const sections = {
  cards: "Карточки",
  editor: "Редактор",
  library: "Библиотека",
  check: "Проверка",
  analytics: "Аналитика",
} as const;

export type DemoSection = keyof typeof sections;
export type UpdateDemo = (
  update: (state: BrowserDemoState) => BrowserDemoState
) => void;

function subscribeHydration() {
  return () => {};
}
function readLocalState() {
  try {
    return { state: readBrowserDemo(window.localStorage), error: null };
  } catch (error) {
    return { state: null, error: getDemoError(error) };
  }
}

export function BrowserDemo() {
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    () => true,
    () => false
  );

  return (
    <section className="atlas-wrap mx-auto w-full min-w-0 max-w-[72rem] space-y-6 px-4 py-6 pb-24 sm:px-6">
      <WorkspaceMasthead
        id="browser-demo-title"
        icon={FlaskConical}
        title="Демо-режим Канона"
        description="Попробуйте карточки, согласование и редактор на учебных примерах. Изменения сохраняются в этом браузере."
      >
        <Link href="/login" className={buttonVariants({ variant: "outline" })}>
          Выйти из демо
        </Link>
      </WorkspaceMasthead>
      {hydrated ? (
        <DemoSession />
      ) : (
        <p role="status">Открываем учебные примеры…</p>
      )}
    </section>
  );
}

function DemoSession() {
  const [stored, setStored] = useState(readLocalState);
  const [resetOpen, setResetOpen] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    function sync(event: StorageEvent) {
      if (event.key === BROWSER_DEMO_KEY || event.key === null) {
        setStored(readLocalState());
      }
    }
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const update: UpdateDemo = (operation) => {
    const storage = window.localStorage;
    const next = operation(readBrowserDemo(storage));
    writeBrowserDemo(storage, next);
    setStored({ state: next, error: null });
  };
  const reset = () => {
    try {
      const state = resetBrowserDemo(window.localStorage);
      setStored({ state, error: null });
      setGeneration((previous) => previous + 1);
      setResetOpen(false);
      setNotice("Учебные примеры восстановлены.");
    } catch (error) {
      setNotice(getDemoError(error));
      setResetOpen(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border bg-card p-4 text-card-foreground">
        {stored.state ? (
          <div className="min-w-0 max-w-full">
            <label
              htmlFor="browser-demo-profile"
              className="mb-1 block text-sm font-medium"
            >
              Учебная роль
            </label>
            <select
              id="browser-demo-profile"
              value={stored.state.profile}
              className="min-h-10 w-full min-w-0 max-w-full rounded-md border bg-background px-3 text-sm"
              onChange={(event) => {
                try {
                  const profile = event.target.value;
                  update((state) => selectDemoProfile(state, profile));
                  setNotice("");
                } catch (error) {
                  setNotice(getDemoError(error));
                }
              }}
            >
              {demoAccounts.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {roleShortLabels[profile.role]} · {profile.organization}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="max-w-xl text-sm text-destructive" role="alert">
            {stored.error}
          </p>
        )}
        <Dialog open={resetOpen} onOpenChange={setResetOpen}>
          <DialogTrigger render={<Button variant="outline" type="button" />}>
            <RotateCcw aria-hidden="true" />
            Сбросить демо
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Восстановить учебные примеры?</DialogTitle>
              <DialogDescription>
                Изменённые карточки и сохранённые демоматериалы в этом браузере
                будут удалены.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" type="button" />}>
                Отмена
              </DialogClose>
              <Button type="button" onClick={reset}>
                Сбросить изменения
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {stored.state && (
        <DemoWorkspace key={generation} state={stored.state} update={update} />
      )}
    </>
  );
}

function DemoWorkspace({
  state,
  update,
}: {
  state: BrowserDemoState;
  update: UpdateDemo;
}) {
  const [section, setSection] = useState<DemoSection>("cards");
  const [selectedCard, selectCard] = useState<{
    id: string;
    approved: boolean;
  } | null>(null);
  const cards = approvedDemoCards(state);

  function openCard(id: string) {
    selectCard({ id, approved: true });
    setSection("cards");
  }

  return (
    <>
      <nav aria-label="Учебные разделы" className="flex flex-wrap gap-2">
        {(Object.entries(sections) as Array<[DemoSection, string]>).map(
          ([id, label]) => (
            <Button
              key={id}
              type="button"
              variant={id === section ? "default" : "outline"}
              aria-current={id === section ? "page" : undefined}
              onClick={() => setSection(id)}
            >
              {label}
            </Button>
          )
        )}
      </nav>
      {section === "cards" && (
        <DemoCards
          state={state}
          update={update}
          selected={selectedCard}
          onSelect={(id) => selectCard({ id, approved: false })}
        />
      )}
      {section === "editor" && (
        <DemoEditor key={state.profile} state={state} update={update} />
      )}
      {section === "library" && (
        <DemoLibrary state={state} openCard={openCard} />
      )}
      {section === "check" && (
        <DemoFactCheck cards={cards} openCard={openCard} />
      )}
      {section === "analytics" && (
        <DemoAnalytics cards={cards} openCard={openCard} />
      )}
      <DemoChat cards={cards} openCard={openCard} navigate={setSection} />
    </>
  );
}
