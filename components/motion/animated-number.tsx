"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

type AnimatedNumberProps = {
  value: number;
  className?: string;
  durationMs?: number;
};

/** SSR-safe tabular counter that counts smoothly once when visible. */
export function AnimatedNumber({
  value,
  className,
  durationMs = 700,
}: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [animatedValue, setAnimatedValue] = useState<number | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || value <= 1) return;

    const reduced =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      document.documentElement.dataset.motion === "off";
    if (reduced) return;

    let rafId = 0;
    let started = false;

    const run = () => {
      if (started) return;
      started = true;
      const startValue = Math.max(0, Math.floor(value * 0.2));
      const startedAt = performance.now();

      const tick = (now: number) => {
        const elapsed = now - startedAt;
        const t = Math.min(1, elapsed / durationMs);
        const eased = 1 - Math.pow(1 - t, 3);
        const next = Math.round(startValue + (value - startValue) * eased);
        if (t < 1) {
          setAnimatedValue(next);
          rafId = requestAnimationFrame(tick);
        } else {
          setAnimatedValue(null);
        }
      };

      rafId = requestAnimationFrame(tick);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          run();
        }
      },
      { threshold: 0.2 }
    );
    observer.observe(node);

    return () => {
      observer.disconnect();
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [value, durationMs]);

  const shown = animatedValue ?? value;

  return (
    <span ref={ref} className={cn("tabular-nums", className)}>
      {shown.toLocaleString("ru-RU")}
    </span>
  );
}
