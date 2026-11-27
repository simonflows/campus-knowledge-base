"use client";

import { useEffect, useRef } from "react";

/** The original nested arcs, with slow movement of their actual geometry. */
export function MastheadContours({
  className,
  dark = false,
}: {
  className: string;
  dark?: boolean;
}) {
  const fieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const field = fieldRef.current;
    const canvas = field?.querySelector("canvas");
    const context = canvas?.getContext("2d");
    if (!field || !canvas || !context) return;
    const root = document.documentElement;
    const preference = matchMedia(
      "(prefers-reduced-motion: reduce), (forced-colors: active)"
    );
    let width = 0,
      height = 0,
      elapsed = 0;
    let frame: number | null = null,
      previous: number | null = null;
    let inView = false;
    let reduced = preference.matches;
    const disabled = () => reduced || root.dataset.motion === "off";
    function paint() {
      if (!width || !height) return;
      const time = disabled() ? 0 : elapsed / 1000;
      context!.clearRect(0, 0, width, height);
      const centerX = width * (dark ? 0.68 : 0.67);
      const centerY = height * (dark ? 0.12 : 1);
      const maxRadius = Math.hypot(width, height) * 1.25;
      for (
        let radius = 38, index = 0;
        radius < maxRadius;
        radius += 37, index++
      ) {
        const phase = time * 0.55 + index * 0.19;
        const x = centerX + Math.sin(phase) * 9;
        const y = centerY + Math.cos(phase * 0.9) * 7;
        const rx = radius + Math.sin(phase + 1) * 5;
        const ry = radius * 0.46 + Math.cos(phase) * 3;
        context!.beginPath();
        context!.ellipse(
          x,
          y,
          rx,
          ry,
          Math.sin(phase * 0.7) * 0.012,
          0,
          Math.PI * 2
        );
        context!.strokeStyle =
          index === 8
            ? dark
              ? "#f59a6880"
              : "#ba895242"
            : dark
              ? "#87cbeb38"
              : "#44768a26";
        context!.lineWidth = index === 8 ? 1.2 : 1;
        context!.stroke();
      }
      field!.dataset.painted = "true";
    }
    function resize() {
      width = canvas!.clientWidth;
      height = canvas!.clientHeight;
      if (!width || !height) return;
      const ratio = Math.min(
        devicePixelRatio || 1,
        1.25,
        Math.sqrt(700_000 / (width * height))
      );
      canvas!.width = Math.max(1, Math.floor(width * ratio));
      canvas!.height = Math.max(1, Math.floor(height * ratio));
      context!.setTransform(
        canvas!.width / width,
        0,
        0,
        canvas!.height / height,
        0,
        0
      );
      paint();
    }
    function draw(timestamp: number) {
      if (previous === null || timestamp - previous >= 1000 / 30 - 1) {
        elapsed = elapsed + Math.min(timestamp - (previous ?? timestamp), 70);
        previous = timestamp;
        paint();
      }
      frame = requestAnimationFrame(draw);
    }
    function stop() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      previous = null;
    }
    function sync() {
      const paused = disabled() || document.hidden || !inView;
      field!.dataset.paused = String(paused);
      if (paused) {
        stop();
        if (disabled()) paint();
      } else if (frame === null) frame = requestAnimationFrame(draw);
    }
    const visibility = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      sync();
    });
    const sizing = new ResizeObserver(resize);
    const motion = new MutationObserver(sync);
    visibility.observe(field);
    sizing.observe(field);
    motion.observe(root, {
      attributes: true,
      attributeFilter: ["data-motion"],
    });
    function mediaChanged(event: MediaQueryListEvent) {
      reduced = event.matches;
      sync();
    }
    preference.addEventListener("change", mediaChanged);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("resize", resize);
    resize();
    sync();
    return () => {
      stop();
      visibility.disconnect();
      sizing.disconnect();
      motion.disconnect();
      preference.removeEventListener("change", mediaChanged);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("resize", resize);
    };
  }, [dark]);
  return (
    <div
      ref={fieldRef}
      className={className}
      data-masthead-contours
      aria-hidden="true"
    >
      <canvas style={{ width: "100%", height: "100%", display: "block" }} />
    </div>
  );
}
