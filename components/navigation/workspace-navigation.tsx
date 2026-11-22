"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createContext, useContext, useMemo, type ComponentProps } from "react";
import { demoHref, type DemoLocation } from "@/lib/browser-demo-navigation";

export type DemoNavigation = {
  location: DemoLocation;
  navigate(
    href: string,
    options?: { scroll?: boolean; replace?: boolean }
  ): void;
};
export const DemoNavigationContext = createContext<DemoNavigation | null>(null);

export function useWorkspacePathname() {
  const pathname = usePathname();
  return useContext(DemoNavigationContext)?.location.pathname ?? pathname;
}

export function useWorkspaceNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const demo = useContext(DemoNavigationContext);
  return useMemo(() => {
    if (demo) {
      return {
        pathname: demo.location.pathname,
        searchParams: new URLSearchParams(demo.location.search),
        push: demo.navigate,
        replace: (href: string, options?: { scroll?: boolean }) =>
          demo.navigate(href, { ...options, replace: true }),
        replaceHistory: (href: string) =>
          demo.navigate(href, { replace: true, scroll: false }),
        refresh: () => {},
      };
    }
    return {
      pathname,
      searchParams,
      push: router.push,
      replace: router.replace,
      refresh: router.refresh,
      replaceHistory: (href: string) =>
        window.history.replaceState(null, "", href),
    };
  }, [demo, pathname, router, searchParams]);
}

export function WorkspaceExternalLink({
  children,
  className,
  ...props
}: ComponentProps<"a">) {
  const demo = useContext(DemoNavigationContext);
  return demo ? (
    <span className={className} title="Внешний источник в учебном режиме">
      {children}
    </span>
  ) : (
    <a className={className} {...props}>
      {children}
    </a>
  );
}

export function AppLink({
  href,
  children,
  prefetch,
  scroll,
  replace,
  onClick,
  onNavigate,
  ...props
}: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const demo = useContext(DemoNavigationContext);
  if (!demo) {
    return (
      <Link
        href={href}
        prefetch={prefetch}
        scroll={scroll}
        replace={replace}
        onClick={onClick}
        onNavigate={onNavigate}
        {...props}
      >
        {children}
      </Link>
    );
  }
  const fragment = demoHref(href, demo.location);
  if (fragment === null)
    return <span className={props.className}>{children}</span>;
  return (
    <a
      href={fragment}
      {...props}
      onClick={(event) => {
        onClick?.(event);
        const target = event.currentTarget.getAttribute("target");
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          (target && target !== "_self") ||
          event.currentTarget.hasAttribute("download")
        )
          return;
        event.preventDefault();
        let cancelled = false;
        onNavigate?.({
          preventDefault: () => {
            cancelled = true;
          },
        });
        if (cancelled) return;
        demo.navigate(href, { scroll, replace });
      }}
    >
      {children}
    </a>
  );
}
