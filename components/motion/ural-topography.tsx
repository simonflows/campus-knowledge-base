"use client";

import { useEffect, useRef } from "react";
import styles from "./ural-topography.module.css";

const ridges = [
  {
    transform: "translate(76 514) rotate(31)",
    outline:
      "M -23 -249 C 26 -251 68 -213 67 -160 C 66 -113 114 -91 137 -39 C 158 2 129 35 115 74 C 100 119 139 157 100 206 C 61 257 -1 253 -37 205 C -68 164 -107 157 -119 110 C -131 59 -80 34 -87 -12 C -93 -58 -136 -84 -114 -130 C -95 -169 -66 -173 -66 -206 C -66 -235 -46 -248 -23 -249 Z",
  },
  {
    transform: "translate(1375 239) rotate(-26)",
    outline:
      "M 17 -283 C 64 -267 43 -222 78 -198 C 117 -171 145 -152 141 -106 C 138 -63 104 -46 112 -10 C 121 32 171 54 170 98 C 167 151 109 164 81 204 C 53 244 56 274 8 288 C -40 300 -61 251 -85 214 C -112 173 -151 164 -152 118 C -153 72 -118 58 -125 17 C -133 -25 -166 -57 -149 -102 C -130 -148 -85 -145 -69 -188 C -54 -227 -39 -301 17 -283 Z",
  },
];

const contourScales = [0.43, 0.53, 0.63, 0.74, 0.84, 0.93, 1.02, 1.13, 1.25, 1.37, 1.5];

export function UralTopography() {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer || typeof layer.animate !== "function") return;

    const staticMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce), (forced-colors: active)",
    );
    let animation: Animation | undefined;

    const syncMotion = () => {
      if (
        staticMotion.matches ||
        document.documentElement.dataset.motion === "off"
      ) {
        animation?.cancel();
        animation = undefined;
        return;
      }
      if (document.hidden) {
        animation?.pause();
        return;
      }
      if (animation?.playState === "paused") {
        animation.play();
        return;
      }
      animation ??= layer.animate(
        [
          { transform: "translate3d(0, 0, 0)", easing: "ease-out" },
          { transform: "translate3d(-16px, 9px, 0)", easing: "ease-in-out" },
          { transform: "translate3d(0, 0, 0)" },
        ],
        { duration: 4800, iterations: 1 },
      );
    };

    syncMotion();
    staticMotion.addEventListener("change", syncMotion);
    document.addEventListener("visibilitychange", syncMotion);
    return () => {
      staticMotion.removeEventListener("change", syncMotion);
      document.removeEventListener("visibilitychange", syncMotion);
      animation?.cancel();
    };
  }, []);

  return (
    <div className={styles.field} aria-hidden="true" data-home-topography>
      <div className={styles.layer} ref={layerRef} data-topography-motion>
        <svg viewBox="0 0 1440 650" preserveAspectRatio="none" focusable="false">
          {ridges.map(({ transform, outline }) => (
            <g key={transform} transform={transform}>
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
          ))}
        </svg>
      </div>
    </div>
  );
}
