"use client";

import { useSyncExternalStore } from "react";

function subscribeVisibility(onStoreChange: () => void) {
  document.addEventListener("visibilitychange", onStoreChange);
  return () => document.removeEventListener("visibilitychange", onStoreChange);
}

const getHiddenSnapshot = () => document.hidden;
const getServerSnapshot = () => false;

/** Fixed subtle gradient mesh behind all pages; pauses when tab is hidden. */
export function AmbientBackdrop() {
  const paused = useSyncExternalStore(
    subscribeVisibility,
    getHiddenSnapshot,
    getServerSnapshot
  );

  return (
    <div
      className="atlas-ambient-bg"
      data-paused={paused ? "true" : undefined}
      aria-hidden="true"
    >
      <div className="atlas-ambient-orb atlas-ambient-orb--sky" />
      <div className="atlas-ambient-orb atlas-ambient-orb--mint" />
      <div className="atlas-ambient-orb atlas-ambient-orb--copper" />
      <div className="atlas-ambient-grid" />
    </div>
  );
}
