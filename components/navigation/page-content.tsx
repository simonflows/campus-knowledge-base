"use client";

import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef, type ReactNode } from "react";

export function PageContent({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const previousPathname = useRef(pathname);
  const main = useRef<HTMLElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (previousPathname.current === pathname) return;
    previousPathname.current = pathname;

    if (
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      document.documentElement.dataset.motion === "off"
    ) {
      return;
    }

    const pageTransition = main.current?.animate?.(
      [
        { opacity: 0, transform: "translateY(12px) scale(0.996)" },
        { opacity: 1, transform: "translateY(0) scale(1)" },
      ],
      {
        duration: 320,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      }
    );

    const barTransition = progressRef.current?.animate?.(
      [
        { opacity: 0.95, transform: "scaleX(0.08)" },
        { opacity: 1, transform: "scaleX(0.82)", offset: 0.45 },
        { opacity: 0, transform: "scaleX(1)" },
      ],
      {
        duration: 520,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      }
    );

    return () => {
      pageTransition?.cancel();
      barTransition?.cancel();
    };
  }, [pathname]);

  return (
    <>
      <div ref={progressRef} className="atlas-route-bar" aria-hidden="true" />
      <main ref={main} id="main-content" className="min-w-0 flex-1">
        {children}
      </main>
    </>
  );
}
