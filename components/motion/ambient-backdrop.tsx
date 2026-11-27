"use client";

import { useEffect, useRef } from "react";
import { ReliefPattern } from "./relief-pattern";
import styles from "./ambient-backdrop.module.css";

/** Decorative only: never intercepts input, network requests, or page content. */
export function AmbientBackdrop() {
  const fieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const preference = matchMedia(
      "(prefers-reduced-motion: reduce), (forced-colors: active)"
    );
    const root = document.documentElement;
    const pulse = field.querySelector<HTMLElement>("[data-relief-pulse]");
    let reaction: Animation | undefined;
    const drift = Array.from(
      field.querySelectorAll("[data-relief-layer]"),
      (layer, index) =>
        layer.animate(
          [
            { transform: "translate3d(0,0,0) rotate(0deg)" },
            {
              transform: `translate3d(${index ? -10 : 12}px,${index ? 12 : -8}px,0) rotate(${index ? -1 : 1}deg)`,
            },
          ],
          {
            duration: index ? 24000 : 20000,
            iterations: Infinity,
            direction: "alternate",
            easing: "ease-in-out",
          }
        )
    );
    function sync() {
      const paused =
        document.hidden || preference.matches || root.dataset.motion === "off";
      field?.setAttribute("data-paused", String(paused));
      drift.forEach((animation) =>
        paused ? animation.pause() : animation.play()
      );
      if (paused) reaction?.cancel();
    }
    function acknowledge(event: PointerEvent) {
      if (
        !pulse ||
        document.hidden ||
        preference.matches ||
        root.dataset.motion === "off" ||
        event.button !== 0
      )
        return;
      const target = event.target;
      if (
        !(target instanceof Element) ||
        !target.closest(
          "button,a,input,textarea,select,summary,[role='button']"
        )
      )
        return;
      pulse.style.left = `${event.clientX}px`;
      pulse.style.top = `${event.clientY}px`;
      reaction?.cancel();
      reaction = pulse.animate(
        [
          { opacity: 0, transform: "translate(-50%,-50%) scale(.75)" },
          { opacity: 0.65, offset: 0.22 },
          { opacity: 0, transform: "translate(-50%,-50%) scale(1.2)" },
        ],
        { duration: 1100, easing: "cubic-bezier(.16,1,.3,1)" }
      );
    }
    const observer = new MutationObserver(sync);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-motion"],
    });
    preference.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    document.addEventListener("pointerdown", acknowledge, { passive: true });
    sync();
    return () => {
      drift.forEach((animation) => animation.cancel());
      reaction?.cancel();
      observer.disconnect();
      preference.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      document.removeEventListener("pointerdown", acknowledge);
    };
  }, []);
  return (
    <div
      ref={fieldRef}
      className={`atlas-ambient-bg ${styles.field}`}
      aria-hidden="true"
    >
      <div className={styles.wash} />
      <div className={styles.north} data-relief-layer>
        <ReliefPattern side={1} />
      </div>
      <div className={styles.south} data-relief-layer>
        <ReliefPattern side={0} />
      </div>
      <div className={styles.pulse} data-relief-pulse />
    </div>
  );
}
