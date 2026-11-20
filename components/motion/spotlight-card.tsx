"use client";

import { useRef, type ComponentProps, type PointerEvent } from "react";
import { cn } from "@/lib/utils";

/** Tracks pointer coordinates via CSS variables without React re-renders. */
export function SpotlightCard({
  children,
  className,
  onPointerMove,
  ...props
}: ComponentProps<"div">) {
  const cardRef = useRef<HTMLDivElement>(null);

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    onPointerMove?.(event);
    if (event.pointerType !== "mouse" || !cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    cardRef.current.style.setProperty(
      "--mx",
      `${Math.round(event.clientX - rect.left)}px`
    );
    cardRef.current.style.setProperty(
      "--my",
      `${Math.round(event.clientY - rect.top)}px`
    );
  };

  return (
    <div
      ref={cardRef}
      className={cn("atlas-spotlight", className)}
      onPointerMove={handlePointerMove}
      {...props}
    >
      {children}
    </div>
  );
}
