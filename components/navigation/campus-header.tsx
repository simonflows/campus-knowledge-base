"use client";

import { useEffect, useRef, type ComponentProps } from "react";

import { useWorkspacePathname } from "./workspace-navigation";

export function CampusHeader(props: ComponentProps<"header">) {
  const headerRef = useRef<HTMLElement>(null);
  const pathname = useWorkspacePathname();

  useEffect(() => {
    const header = headerRef.current;
    if (!header || pathname !== "/") return;
    const cover = document.querySelector(".atlas-hero");
    if (!cover) return;

    let observer: IntersectionObserver;
    const observe = () => {
      observer?.disconnect();
      const height = header.offsetHeight;
      observer = new IntersectionObserver(([entry]) => {
        if (!entry) return;
        header.toggleAttribute(
          "data-detached",
          !entry.isIntersecting && entry.boundingClientRect.bottom <= height
        );
      }, { rootMargin: `${-height}px 0px 0px` });
      observer.observe(cover);
    };
    const resize = new ResizeObserver(observe);
    resize.observe(header);
    observe();

    return () => {
      resize.disconnect();
      observer?.disconnect();
      header.removeAttribute("data-detached");
    };
  }, [pathname]);

  return <header {...props} ref={headerRef} />;
}
