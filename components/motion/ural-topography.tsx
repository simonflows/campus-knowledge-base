"use client";

import { useEffect, useRef } from "react";
import { contourPeriodMs, contourRidges, paintContours } from "./ural-contours";
import styles from "./ural-topography.module.css";

const maxPixelRatio = 1.5;
const maxPixelsPerRidge = 700_000;
const frameIntervalMs = 1000 / 60;

export function UralTopography() {
  const fieldRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;

    const layers = Array.from(
      field.querySelectorAll("canvas"),
      (canvas, index) => {
        const context = canvas.getContext("2d");
        const ridge = contourRidges[index];
        return {
          canvas,
          context,
          ridge,
          points: new Float32Array(ridge.contours[0].length),
          width: 0,
          height: 0,
        };
      }
    );
    if (!layers.some(({ context }) => context)) return;

    const motionPreference = window.matchMedia(
      "(prefers-reduced-motion: reduce), (forced-colors: active)"
    );
    const root = document.documentElement;
    const motionDisabled = () =>
      motionPreference.matches || root.dataset.motion === "off";
    let reduced = motionDisabled();
    let inView = typeof IntersectionObserver !== "function";
    let frame: number | null = null;
    let previousFrame: number | null = null;
    let elapsed = 0;

    function paint() {
      for (const { context, ridge, points, width, height } of layers) {
        if (context && width && height) {
          paintContours(
            context,
            ridge,
            points,
            width,
            height,
            reduced ? null : elapsed
          );
        }
      }
    }

    function resize() {
      for (const layer of layers) {
        const { canvas, context } = layer;
        const { clientWidth: width, clientHeight: height } = canvas;
        if (!context || width <= 0 || height <= 0) continue;
        const ratio = Math.min(
          window.devicePixelRatio || 1,
          maxPixelRatio,
          Math.sqrt(maxPixelsPerRidge / (width * height))
        );
        const bitmapWidth = Math.max(1, Math.floor(width * ratio));
        const bitmapHeight = Math.max(1, Math.floor(height * ratio));
        if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth;
        if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight;
        context.setTransform(
          bitmapWidth / width,
          0,
          0,
          bitmapHeight / height,
          0,
          0
        );
        layer.width = width;
        layer.height = height;
      }
      paint();
    }

    function draw(timestamp: number) {
      if (
        previousFrame === null ||
        timestamp - previousFrame >= frameIntervalMs - 1
      ) {
        // Pausing or a busy main thread should never jump across the contour field.
        const delta = timestamp - (previousFrame ?? timestamp);
        elapsed = (elapsed + Math.min(delta, 50)) % contourPeriodMs;
        previousFrame = timestamp;
        paint();
      }
      frame = requestAnimationFrame(draw);
    }

    function stop() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      previousFrame = null;
    }

    function syncMotion() {
      const disabled = motionDisabled();
      if (disabled !== reduced) {
        reduced = disabled;
        if (reduced) paint();
      }
      if (reduced || !inView || document.hidden) {
        stop();
      } else if (frame === null) {
        frame = requestAnimationFrame(draw);
      }
    }

    const visibility =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            inView = entry.isIntersecting;
            syncMotion();
          })
        : null;
    const sizing = new ResizeObserver(resize);
    const motionAttribute = new MutationObserver(syncMotion);
    visibility?.observe(field);
    sizing.observe(field);
    motionAttribute.observe(root, {
      attributes: true,
      attributeFilter: ["data-motion"],
    });
    motionPreference.addEventListener("change", syncMotion);
    document.addEventListener("visibilitychange", syncMotion);
    // Resize also catches a change of display density without a CSS size change.
    window.addEventListener("resize", resize);
    resize();
    syncMotion();
    return () => {
      stop();
      visibility?.disconnect();
      sizing.disconnect();
      motionAttribute.disconnect();
      motionPreference.removeEventListener("change", syncMotion);
      document.removeEventListener("visibilitychange", syncMotion);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div
      className={styles.field}
      ref={fieldRef}
      aria-hidden="true"
      data-home-topography
    >
      <canvas className={styles.ridge} />
      <canvas className={styles.ridge} />
    </div>
  );
}
