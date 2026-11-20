"use client";

import { type ReactNode, useEffect, useRef } from "react";
import { mountFloatingCards } from "@/components/floating-cards";

export function AtlasCover({
  children,
  links,
}: {
  children: ReactNode;
  links: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const beam = useRef<HTMLDivElement>(null);
  const echo = useRef<HTMLDivElement>(null);
  const copper = useRef<HTMLDivElement>(null);
  const scene = useRef<HTMLElement>(null);

  const signal = useRef<SVGCircleElement>(null);
  const signal2 = useRef<SVGCircleElement>(null);

  useEffect(() => {
    const cover = frame.current;
    const field = beam.current;
    const light = echo.current;
    const warm = copper.current;
    const point = signal.current;
    const point2 = signal2.current;
    if (
      !cover ||
      !field ||
      !light ||
      !warm ||
      !point ||
      !point2 ||
      !scene.current
    )
      return;

    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const easing =
      getComputedStyle(cover).getPropertyValue("--m-ease-io").trim() ||
      "ease-in-out";
    const movement = field.animate(
      [
        { transform: "translate(-3%, 2%) rotate(-4deg)" },
        { transform: "translate(4%, -3%) rotate(3deg)" },
      ],
      { duration: 9200, direction: "alternate", easing, iterations: Infinity }
    );
    const glint = light.animate(
      [
        { transform: "translate(3%, -3%)", opacity: 0.45 },
        { transform: "translate(-4%, 4%)", opacity: 0.92 },
      ],
      { duration: 7500, direction: "alternate", easing, iterations: Infinity }
    );
    const ember = warm.animate(
      [
        { transform: "translate(-3%, -2%) scale(0.96)", opacity: 0.45 },
        { transform: "translate(4%, 3%) scale(1.06)", opacity: 0.9 },
      ],
      { duration: 10800, direction: "alternate", easing, iterations: Infinity }
    );

    const trace = point.animate(
      [
        { offsetDistance: "0%", opacity: 0 },
        { offsetDistance: "12%", opacity: 0.92, offset: 0.12 },
        { offsetDistance: "88%", opacity: 0.92, offset: 0.88 },
        { offsetDistance: "100%", opacity: 0 },
      ],
      { duration: 12500, easing: "linear", iterations: Infinity }
    );
    trace.currentTime = 3600;

    const traceSecondary = point2.animate(
      [
        { offsetDistance: "0%", opacity: 0 },
        { offsetDistance: "14%", opacity: 0.85, offset: 0.14 },
        { offsetDistance: "86%", opacity: 0.85, offset: 0.86 },
        { offsetDistance: "100%", opacity: 0 },
      ],
      { duration: 12500, easing: "linear", iterations: Infinity }
    );
    traceSecondary.currentTime = 9800;

    const animations = [movement, glint, ember, trace, traceSecondary];
    const cards = mountFloatingCards(scene.current);
    let intersecting = false;
    const sync = () => {
      const visible = intersecting && !document.hidden;
      cover.dataset.visible = String(visible);
      cards.sync(visible, preference.matches);
      for (const animation of animations) {
        if (preference.matches) {
          animation.cancel();
        } else if (visible) {
          animation.play();
        } else {
          animation.pause();
        }
      }
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      sync();
    });
    observer.observe(cover);
    sync();
    preference.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      cards.dispose();
      observer.disconnect();
      preference.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      for (const animation of animations) animation.cancel();
    };
  }, []);

  return (
    <section className="atlas-hero hero" aria-labelledby="campus-title">
      <div
        className="atlas-cover"
        ref={frame}
        data-visual=""
        aria-hidden="true"
      >
        <div className="atlas-cover-grid" />
        <div className="atlas-light-field" ref={beam} />
        <div className="atlas-light-echo" ref={echo} />
        <div className="atlas-light-copper" ref={copper} />
      </div>
      <div className="wrap atlas-wrap">
        <div className="atlas-hero-main">{children}</div>
        <nav
          ref={scene}
          className="atlas-scene"
          aria-label="Материалы и сервисы кампуса"
        >
          <svg
            className="atlas-connections"
            viewBox="0 0 1200 220"
            preserveAspectRatio="none"
            fill="none"
            aria-hidden="true"
          >
            <path
              id="atlas-service-links"
              d="M90 60 C180 60 175 196 410 167 S666 98 837 136 S1055 170 1110 73"
            />
            <path d="M90 60 C247 25 266 82 410 167 M837 136 C967 105 978 52 1110 73" />
            <circle
              className="atlas-signal"
              ref={signal}
              r="2.8"
              style={{ offsetPath: "url(#atlas-service-links)" }}
            />
            <circle
              className="atlas-signal atlas-signal-secondary"
              ref={signal2}
              r="2.4"
              style={{ offsetPath: "url(#atlas-service-links)" }}
            />
          </svg>
          {links}
        </nav>
      </div>
    </section>
  );
}
