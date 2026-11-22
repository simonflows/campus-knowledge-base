"use client";

import { useWorkspaceMode, useWorkspaceRequest } from "@/components/demo/workspace-transport";

import { useEffect, useRef, useState } from "react";
import { Autocomplete } from "@base-ui/react/autocomplete";
import {
  ArrowRight,
  ArrowUpRight,
  FileText,
  Search,
  SquareArrowOutUpRight,
} from "lucide-react";
import { AppLink as Link, useWorkspaceNavigation } from "@/components/navigation/workspace-navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  campusServices,
  findCampusServices,
  type CampusSearchResult,
} from "@/lib/campus-services";
import "./home-search.css";

type CardResponse = {
  query: string;
  cards: CampusSearchResult[];
  failed?: boolean;
};
const quickServices = campusServices().filter(({ href }) =>
  ["/editor", "/check", "/analytics"].includes(href)
);

export function HomeSearchInput({
  basePath,
  examples,
}: {
  basePath: string;
  examples: string[];
}) {
  const workspaceRequest = useWorkspaceRequest();
  const router = useWorkspaceNavigation();
  const demo = useWorkspaceMode() === "demo";
  const form = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [response, setResponse] = useState<CardResponse | null>(null);
  const query = value.trim();
  const services = query ? findCampusServices(query) : quickServices;
  const result = response?.query === query ? response : null;
  const cards = result?.cards ?? [];
  const allHref = query
    ? `/knowledge?q=${encodeURIComponent(query)}`
    : "/knowledge";
  const groups = [
    {
      label: query ? "Сервисы" : "Быстрые переходы",
      items: services,
      icon: SquareArrowOutUpRight,
    },
    { label: "Материалы справочника", items: cards, icon: FileText },
  ].filter((group) => group.items.length);

  useEffect(() => {
    if (!query || !open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await workspaceRequest(
          `${demo ? "" : basePath}/api/search?q=${encodeURIComponent(query)}`,
          {
            cache: "no-store",
            signal: controller.signal,
          }
        );
        if (!response.ok) throw new Error("search");
        const data: { cards: CampusSearchResult[] } = await response.json();
        if (!controller.signal.aborted)
          setResponse({ query, cards: data.cards });
      } catch {
        if (!controller.signal.aborted)
          setResponse({ query, cards: [], failed: true });
      }
    }, 160);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [basePath, demo, open, query, workspaceRequest]);

  const status = !query
    ? ""
    : !result
      ? "Ищем карточки…"
      : result.failed
        ? "Не удалось загрузить карточки."
        : !services.length && !cards.length
          ? "По этому запросу ничего не найдено."
          : "";

  return (
    <div className="campus-home-search">
      <label className="atlas-search-label" htmlFor="home-search">
        Поиск по всему сайту
      </label>
      <Autocomplete.Root
        value={value}
        onValueChange={(next, details) => {
          if (
            details.reason !== "item-press" &&
            details.reason !== "escape-key"
          )
            setValue(next);
        }}
        open={open}
        onOpenChange={setOpen}
        mode="none"
        openOnInputClick
        itemToStringValue={(item: CampusSearchResult) => item.title}
      >
        <form
          action={demo ? undefined : `${basePath}/knowledge`}
          method={demo ? undefined : "get"}
          role="search"
          className="atlas-search"
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            setOpen(false);
            router.push(query && services.length ? services[0].href : allHref);
          }}
        >
          <Search size={20} aria-hidden="true" />
          <Autocomplete.Input
            render={<Input />}
            ref={input}
            id="home-search"
            name="q"
            type="text"
            maxLength={1000}
            autoComplete="off"
            enterKeyHint="search"
            placeholder="Поиск по кампусу"
            onFocus={() => setOpen(true)}
          />
          <Button type="submit">
            Найти <ArrowRight data-icon="inline-end" aria-hidden="true" />
          </Button>
        </form>
        <Autocomplete.Portal>
          <Autocomplete.Positioner
            anchor={form}
            side="bottom"
            sideOffset={6}
            align="start"
            className="campus-search-positioner"
          >
            <Autocomplete.Popup className="campus-search-panel">
              {status && (
                <p className="campus-search-status" role="status">
                  {status}
                </p>
              )}
              <Autocomplete.List aria-label="Результаты поиска">
                {groups.map(({ label, items, icon: Icon }) => (
                  <Autocomplete.Group key={label}>
                    <Autocomplete.GroupLabel className="campus-search-group">
                      {label}
                    </Autocomplete.GroupLabel>
                    {items.map((item) => (
                      <Autocomplete.Item
                        key={item.href}
                        value={item}
                        className="campus-search-option"
                        render={<Link href={item.href} prefetch={false} />}
                      >
                        <Icon size={17} aria-hidden="true" />
                        <span>
                          <strong>{item.title}</strong>
                          {item.detail && <small>{item.detail}</small>}
                        </span>
                        <ArrowUpRight size={15} aria-hidden="true" />
                      </Autocomplete.Item>
                    ))}
                  </Autocomplete.Group>
                ))}
                {query && (
                  <Autocomplete.Item
                    value={{
                      href: allHref,
                      title: "Все результаты в справочнике",
                    }}
                    className="campus-search-option campus-search-all"
                    render={<Link href={allHref} prefetch={false} />}
                  >
                    <Search size={17} aria-hidden="true" />
                    <span>Все результаты в справочнике</span>
                    <ArrowRight size={16} aria-hidden="true" />
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
      <div className="atlas-topics campus-search-examples">
        <span>Например</span>
        {examples.map((topic) => (
          <button
            type="button"
            key={topic}
            onClick={() => {
              setValue(topic);
              setOpen(true);
              input.current?.focus();
            }}
          >
            {topic}
          </button>
        ))}
      </div>
    </div>
  );
}
