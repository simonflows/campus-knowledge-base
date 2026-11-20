"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef } from "react";
import {
  BarChart3,
  BookOpen,
  Cpu,
  Home,
  Inbox,
  PenLine,
  ScanText,
  ShieldCheck,
} from "lucide-react";
import { campusServices } from "@/lib/campus-services";

const sections = [
  { href: "/", title: "Главная", navTitle: "Главная" },
  ...campusServices(),
];

const sectionIcons = {
  "/": Home,
  "/knowledge": BookOpen,
  "/editor": PenLine,
  "/check": ScanText,
  "/requests": Inbox,
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

export function HeaderNav({ incomingCount = 0 }: { incomingCount?: number }) {
  const pathname = usePathname();
  const navRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    positionIndicator(navRef.current, true);
  }, [pathname]);

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
  }, []);

  return (
    <nav ref={navRef} aria-label="Основная навигация" className="atlas-nav">
      <span aria-hidden="true" className="atlas-nav-indicator" />
      {sections.map(({ href, navTitle }) =>
        href === "/login" ? null : (
          <Link
            key={href}
            href={href}
            aria-current={pathname === href ? "page" : undefined}
          >
            {navTitle}
            {href === "/requests" && incomingCount > 0 && (
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
  onNavigate,
}: {
  incomingCount?: number;
  onNavigate: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Основная навигация" className="atlas-mobile-nav">
      {sections.map(({ href, title }) => {
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
            {href === "/requests" && incomingCount > 0 && (
              <RequestCount count={incomingCount} />
            )}
          </Link>
        );
      })}
    </nav>
  );
}
