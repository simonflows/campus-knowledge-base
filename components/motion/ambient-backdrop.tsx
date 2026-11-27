"use client";

import { useEffect, useRef } from "react";
import styles from "./ambient-backdrop.module.css";

/** A quiet processing state, never a permanent page decoration. */
export function AmbientBackdrop() {
  const fieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const field = fieldRef.current;
    const color = field?.querySelector<HTMLElement>("[data-ambient-color]");
    if (!field || !color) return;
    const preference = matchMedia(
      "(prefers-reduced-motion: reduce), (forced-colors: active)"
    );
    let reduced = preference.matches;
    const root = document.documentElement;
    const drift = color.animate(
      [
        { transform: "translate3d(-2%,1%,0) scale(1)" },
        { transform: "translate3d(2%,-1%,0) scale(1.06)" },
      ],
      {
        duration: 7000,
        iterations: Infinity,
        direction: "alternate",
        easing: "ease-in-out",
      }
    );
    drift.pause();
    let scheduled = 0;
    function sync() {
      scheduled = 0;
      const active =
        !document.hidden && !!document.querySelector('[aria-busy="true"]');
      const paused = !active || reduced || root.dataset.motion === "off";
      field!.dataset.active = String(active);
      field!.dataset.paused = String(paused);
      if (paused) drift.pause();
      else drift.play();
    }
    function schedule() {
      if (!scheduled) scheduled = requestAnimationFrame(sync);
    }
    const work = new MutationObserver(schedule);
    work.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["aria-busy"],
    });
    function syncImmediately() {
      cancelAnimationFrame(scheduled);
      sync();
    }
    const motion = new MutationObserver(syncImmediately);
    motion.observe(root, {
      attributes: true,
      attributeFilter: ["data-motion"],
    });
    function mediaChanged(event: MediaQueryListEvent) {
      reduced = event.matches;
      syncImmediately();
    }
    preference.addEventListener("change", mediaChanged);
    document.addEventListener("visibilitychange", syncImmediately);
    sync();
    return () => {
      cancelAnimationFrame(scheduled);
      drift.cancel();
      work.disconnect();
      motion.disconnect();
      preference.removeEventListener("change", mediaChanged);
      document.removeEventListener("visibilitychange", syncImmediately);
    };
  }, []);
  return (
    <div
      ref={fieldRef}
      className={`atlas-ambient-bg ${styles.field}`}
      data-active="false"
      data-paused="true"
      aria-hidden="true"
    >
      <div className={styles.color} data-ambient-color />
    </div>
  );
}
