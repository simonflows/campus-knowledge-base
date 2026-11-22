"use client";

import { AppLink as Link, useWorkspacePathname } from "@/components/navigation/workspace-navigation";
import { useWorkspaceMode } from "@/components/demo/workspace-transport";
import { useLayoutEffect, useRef } from "react";
import {
  BarChart3,
  BookOpen,
  ClipboardList,
  Cpu,
  Home,
  Inbox,
  PenLine,
  ScanText,
  ShieldCheck,
} from "lucide-react";
import { campusServices } from "@/lib/campus-services";

function navSections(staff: boolean, demo: boolean) {
  return [
    { href: "/", title: "Главная", navTitle: "Главная" },
    ...campusServices(demo ? false : undefined, staff).filter(({ href }) => !staff || href !== "/requests"),
  ];
}

const sectionIcons = {
  "/": Home,
  "/knowledge": BookOpen,
  "/editor": PenLine,
  "/check": ScanText,
  "/requests": Inbox,
  "/work": ClipboardList,
  "/analytics": BarChart3,
  "/comparison": Cpu,
  "/login": ShieldCheck,
} as Record<string, typeof Home>;

function positionIndicator(nav: HTMLElement | null, slide: boolean) {
  const indicator = nav?.querySelector<HTMLElement>(".atlas-nav-indicator");
  if (!nav || !indicator) return;

  const active = nav.querySelector('[aria-current="page"]');
  const target = active?.getBoundingClientRect();
  if (!target?.width || !target.height) {
    nav.removeAttribute("data-positioned");
    nav.removeAttribute("data-sliding");
    return;
  }

  const track = indicator.getBoundingClientRect();
  const left = target.left - track.left;
  // The clip keeps the pill's ends round as it moves and changes width.
  const clip = `inset(${target.top - track.top}px ${track.right - target.right}px ${track.bottom - target.bottom}px ${left}px round 999px)`;
  const positioned = nav.hasAttribute("data-positioned");
  if (positioned && indicator.dataset.clip === clip) return;

  nav.toggleAttribute("data-sliding", slide && positioned);
  indicator.dataset.clip = clip;
  indicator.style.clipPath = clip;
  nav.setAttribute("data-positioned", "");
}

function RequestCount({ count }: { count: number }) {
  return (
    <span className="atlas-nav-count">
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">Входящие запросы: {count}</span>
    </span>
  );
}

export function HeaderNav({ incomingCount = 0, staff = false }: { incomingCount?: number; staff?: boolean }) {
  const pathname = useWorkspacePathname();
  const demo = useWorkspaceMode() === "demo";
  const navRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    positionIndicator(navRef.current, true);
  }, [pathname, staff]);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    const realign = () => positionIndicator(nav, false);
    const observer = new ResizeObserver(realign);
    observer.observe(nav);
    nav.querySelectorAll("a").forEach((link) => observer.observe(link));
    document.fonts.addEventListener("loadingdone", realign);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", realign);
    };
  }, [staff]);

  return (
    <nav ref={navRef} aria-label="Основная навигация" className="atlas-nav">
      <span aria-hidden="true" className="atlas-nav-indicator" />
      {navSections(staff, demo).map(({ href, navTitle }) =>
        href === "/login" ? null : (
          <Link
            key={href}
            href={href}
            aria-current={pathname === href ? "page" : undefined}
          >
            {navTitle}
            {(href === "/requests" || href === "/work") && incomingCount > 0 && (
              <RequestCount count={incomingCount} />
            )}
          </Link>
        )
      )}
    </nav>
  );
}

export function MobileNav({
  incomingCount = 0,
  staff = false,
  onNavigate,
}: {
  incomingCount?: number;
  staff?: boolean;
  onNavigate: () => void;
}) {
  const pathname = useWorkspacePathname();
  const demo = useWorkspaceMode() === "demo";

  return (
    <nav aria-label="Основная навигация" className="atlas-mobile-nav">
      {navSections(staff, demo).map(({ href, title }) => {
        const Icon = sectionIcons[href];
        return (
          <Link
            key={href}
            href={href}
            aria-current={pathname === href ? "page" : undefined}
            onNavigate={onNavigate}
          >
            {Icon && <Icon size={17} aria-hidden="true" />}
            {title}
            {(href === "/requests" || href === "/work") && incomingCount > 0 && (
              <RequestCount count={incomingCount} />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
