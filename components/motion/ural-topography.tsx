"use client";

import { useEffect, useRef } from "react";
import styles from "./ural-topography.module.css";

const ridges = [
  {
    viewBox: "0 0 480 650",
    transform: "translate(76 514) rotate(31)",
    outline:
      "M -23 -249 C 26 -251 68 -213 67 -160 C 66 -113 114 -91 137 -39 C 158 2 129 35 115 74 C 100 119 139 157 100 206 C 61 257 -1 253 -37 205 C -68 164 -107 157 -119 110 C -131 59 -80 34 -87 -12 C -93 -58 -136 -84 -114 -130 C -95 -169 -66 -173 -66 -206 C -66 -235 -46 -248 -23 -249 Z",
    wave: [
      { transform: "translate3d(0, 0, 0) scale(1)", opacity: 0.72, offset: 0 },
      {
        transform: "translate3d(5.4%, -1.8%, 0) scale(1.05, 1.035)",
        opacity: 1,
        offset: 0.28,
      },
      {
        transform: "translate3d(-2.1%, 2.2%, 0) scale(0.985, 1.018)",
        opacity: 0.52,
        offset: 0.72,
      },
      { transform: "translate3d(0, 0, 0) scale(1)", opacity: 0.72, offset: 1 },
    ],
  },
  {
    viewBox: "960 0 480 650",
    transform: "translate(1375 239) rotate(-26)",
    outline:
      "M 17 -283 C 64 -267 43 -222 78 -198 C 117 -171 145 -152 141 -106 C 138 -63 104 -46 112 -10 C 121 32 171 54 170 98 C 167 151 109 164 81 204 C 53 244 56 274 8 288 C -40 300 -61 251 -85 214 C -112 173 -151 164 -152 118 C -153 72 -118 58 -125 17 C -133 -25 -166 -57 -149 -102 C -130 -148 -85 -145 -69 -188 C -54 -227 -39 -301 17 -283 Z",
    wave: [
      { transform: "translate3d(0, 0, 0) scale(1)", opacity: 0.69, offset: 0 },
      {
        transform: "translate3d(1.9%, -1.6%, 0) scale(0.985, 1.015)",
        opacity: 0.5,
        offset: 0.2,
      },
      {
        transform: "translate3d(-5.2%, 2%, 0) scale(1.055, 1.038)",
        opacity: 1,
        offset: 0.58,
      },
      { transform: "translate3d(0, 0, 0) scale(1)", opacity: 0.69, offset: 1 },
    ],
  },
];

const contourScales = [
  0.43, 0.53, 0.63, 0.74, 0.84, 0.93, 1.02, 1.13, 1.25, 1.37, 1.5,
];
const waveDurationMs = 19_000;

export function UralTopography() {
  const fieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const layers = Array.from(
      field.querySelectorAll<HTMLElement>("[data-topography-motion]")
    );
    if (
      layers.length !== ridges.length ||
      layers.some((layer) => typeof layer.animate !== "function")
    )
      return;

    const staticMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce), (forced-colors: active)"
    );
    const root = document.documentElement;
    let animations: Animation[] = [];
    let inView = typeof IntersectionObserver !== "function";
    const cancelWaves = () => {
      for (const animation of animations) animation.cancel();
      animations = [];
    };

    const syncMotion = () => {
      const enabled = !staticMotion.matches && root.dataset.motion !== "off";
      if (!enabled) {
        cancelWaves();
        return;
      }
      const play = inView && !document.hidden;
      if (play && !animations.length) {
        // Each side follows its own phase so contours reveal without flashing in unison.
        animations = layers.map((layer, index) =>
          layer.animate(
            ridges[index].wave.map((frame) => ({
              ...frame,
              easing: "ease-in-out",
            })),
            { duration: waveDurationMs, iterations: Infinity }
          )
        );
      }
      for (const animation of animations) {
        if (play && animation.playState === "paused") animation.play();
        if (!play && animation.playState !== "paused") animation.pause();
      }
    };

    const fieldVisibility =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            inView = entry.isIntersecting;
            syncMotion();
          })
        : null;
    fieldVisibility?.observe(field);
    syncMotion();
    staticMotion.addEventListener("change", syncMotion);
    document.addEventListener("visibilitychange", syncMotion);
    const motionAttribute = new MutationObserver(syncMotion);
    motionAttribute.observe(root, {
      attributes: true,
      attributeFilter: ["data-motion"],
    });
    return () => {
      fieldVisibility?.disconnect();
      motionAttribute.disconnect();
      staticMotion.removeEventListener("change", syncMotion);
      document.removeEventListener("visibilitychange", syncMotion);
      cancelWaves();
    };
  }, []);

  return (
    <div
      className={styles.field}
      ref={fieldRef}
      aria-hidden="true"
      data-home-topography
    >
      <div className={styles.canvas}>
        {ridges.map(({ viewBox, transform, outline, wave }) => (
          <div
            key={viewBox}
            className={styles.layer}
            style={{ opacity: wave[0].opacity }}
            data-topography-motion
          >
            <svg viewBox={viewBox} preserveAspectRatio="none" focusable="false">
              <g transform={transform}>
                {contourScales.map((scale, index) => (
                  <path
                    key={scale}
                    d={outline}
                    transform={`scale(${scale})`}
                    className={index % 4 === 0 ? styles.indexLine : undefined}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </g>
            </svg>
          </div>
        ))}
      </div>
    </div>
  );
}
