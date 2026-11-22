"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { DemoNavigation } from "@/components/navigation/workspace-navigation";
import { demoHref, readDemoLocation } from "@/lib/browser-demo-navigation";

const navigationEvent = "campus-demo-navigation";
const initialFragment = "";
const readFragment = () => window.location.hash;
const serverFragment = () => initialFragment;

function subscribe(listener: () => void) {
  window.addEventListener(navigationEvent, listener);
  window.addEventListener("hashchange", listener);
  window.addEventListener("popstate", listener);
  return () => {
    window.removeEventListener(navigationEvent, listener);
    window.removeEventListener("hashchange", listener);
    window.removeEventListener("popstate", listener);
  };
}

function navigate(
  href: string,
  options?: { scroll?: boolean; replace?: boolean }
) {
  const current = readDemoLocation(readFragment());
  const fragment = demoHref(href, current);
  if (!fragment) return;
  const target = readDemoLocation(fragment);
  if (fragment !== readFragment()) {
    if (options?.replace) window.history.replaceState(null, "", fragment);
    else window.history.pushState(null, "", fragment);
    window.dispatchEvent(new Event(navigationEvent));
  }
  if (options?.scroll === false) return;
  if (target.anchor) {
    requestAnimationFrame(() => {
      const id = target.anchor.slice(1);
      const element = document.getElementById(id);
      element?.scrollIntoView();
      if (id === "main-content") element?.focus({ preventScroll: true });
    });
  } else {
    window.scrollTo(0, 0);
  }
}

export function useDemoLocation(): DemoNavigation {
  const fragment = useSyncExternalStore(
    subscribe,
    readFragment,
    serverFragment
  );
  return useMemo(
    () => ({ location: readDemoLocation(fragment), navigate }),
    [fragment]
  );
}
