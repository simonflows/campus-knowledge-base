"use client";

import { useEffect, useRef, type ReactNode } from "react";

type MotionRevealProps = {
  children: ReactNode;
  className?: string;
  delayMs?: number;
  as?: "div" | "section";
};

/** Gently animates sections and bento cards once when they enter the viewport. */
export function MotionReveal({
  children,
  className,
  delayMs = 0,
  as = "div",
}: MotionRevealProps) {
  const nodeRef = useRef<HTMLElement | null>(null);
  const setNode = (element: HTMLElement | null) => {
    nodeRef.current = element;
  };

  useEffect(() => {
    const node = nodeRef.current;
    if (!node) return;

    const reduced =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      document.documentElement.dataset.motion === "off";
    if (reduced || typeof node.animate !== "function") {
      node.style.opacity = "";
      return;
    }

    const cappedDelay = Math.min(delayMs, 180);
    const reveal = (gentle: boolean, instant = false) => {
      node.style.opacity = "";
      node.animate(
        gentle
          ? [
              { opacity: 0.82, transform: "translateY(8px)" },
              { opacity: 1, transform: "translateY(0)" },
            ]
          : [
              { opacity: 0, transform: "translateY(14px)" },
              { opacity: 1, transform: "translateY(0)" },
            ],
        {
          duration: instant ? 260 : gentle ? 380 : 440,
          delay: instant ? 0 : cappedDelay,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "backwards",
        }
      );
    };

    const rect = node.getBoundingClientRect();
    if (rect.top <= window.innerHeight * 1.05) {
      reveal(true);
      return;
    }

    node.style.opacity = "0";
    let done = false;
    const finish = (instant = false) => {
      if (done) return;
      done = true;
      observer.disconnect();
      window.removeEventListener("scroll", onScrollOrHash);
      window.removeEventListener("hashchange", onHashJump);
      window.clearTimeout(fallbackTimer);
      reveal(false, instant);
    };

    const onScrollOrHash = () => {
      const currentTop = node.getBoundingClientRect().top;
      if (currentTop <= window.innerHeight * 1.12) {
        finish(false);
      }
    };

    const onHashJump = () => finish(true);

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          finish(false);
        }
      },
      { threshold: 0.01, rootMargin: "120px 0px 220px 0px" }
    );
    observer.observe(node);
    window.addEventListener("scroll", onScrollOrHash, { passive: true });
    window.addEventListener("hashchange", onHashJump);

    // Safety guarantee: never leave content hidden if scroll/observer doesn't fire.
    const fallbackTimer = window.setTimeout(() => {
      if (!done) {
        done = true;
        observer.disconnect();
        window.removeEventListener("scroll", onScrollOrHash);
        window.removeEventListener("hashchange", onHashJump);
        node.style.opacity = "";
      }
    }, 850);

    return () => {
      done = true;
      observer.disconnect();
      window.removeEventListener("scroll", onScrollOrHash);
      window.removeEventListener("hashchange", onHashJump);
      window.clearTimeout(fallbackTimer);
      node.style.opacity = "";
    };
  }, [delayMs]);

  const Tag = as;
  return (
    <Tag ref={setNode} className={className}>
      {children}
    </Tag>
  );
}
