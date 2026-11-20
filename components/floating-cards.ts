function dragSpace(card: HTMLElement, scene: HTMLElement) {
  const box = card.getBoundingClientRect();
  const hero = scene.closest(".atlas-hero")!;
  const frame = hero.getBoundingClientRect();
  const compact = getComputedStyle(scene).display === "grid";
  const reach = compact ? 12 : 64;
  const clearance = compact ? 3 : 10;
  const limits = {
    left: Math.min(reach, box.left - frame.left - clearance),
    right: Math.min(reach, frame.right - box.right - clearance),
    up: Math.min(reach, box.top - frame.top - clearance),
    down: Math.min(reach, frame.bottom - box.bottom - clearance),
  };

  for (const obstacle of hero.querySelectorAll(
    ".atlas-scene-card, .campus-home-search"
  )) {
    if (obstacle === card) continue;
    const other = obstacle.getBoundingClientRect();
    const gaps = {
      left: box.left - other.right,
      right: other.left - box.right,
      up: box.top - other.bottom,
      down: other.top - box.bottom,
    };
    // Preserve one clear axis between the two cards, including on a diagonal drag.
    const sides = Object.keys(gaps) as (keyof typeof gaps)[];
    const side = sides.reduce((best, next) =>
      gaps[next] > gaps[best] ? next : best
    );
    limits[side] = Math.min(limits[side], Math.max(0, gaps[side] - clearance));
  }
  return limits;
}

export function mountFloatingCards(scene: HTMLElement) {
  let visible = false;
  let reduced = false;
  const hover = matchMedia("(hover: hover) and (pointer: fine)");
  const listeners = new AbortController();
  const options = { signal: listeners.signal };

  const cards = Array.from(
    scene.querySelectorAll<HTMLElement>(".atlas-scene-card"),
    (card, index) => {
      const drift = card.animate(
        [
          { transform: "translate(0, 0) rotate(0deg)" },
          {
            transform:
              "translate(var(--float-x), var(--float-y)) rotate(var(--float-roll))",
          },
        ],
        {
          duration: 3200 + index * 340,
          direction: "alternate",
          iterations: Infinity,
          easing: "ease-in-out",
        }
      );
      drift.currentTime = index * 1850;
      let gesture: {
        id: number;
        x: number;
        y: number;
        offsetX: number;
        offsetY: number;
        limits: ReturnType<typeof dragSpace>;
        moved: boolean;
      } | null = null;
      let suppressClick = false;

      function sync() {
        if (reduced) drift.cancel();
        else if (
          !visible ||
          gesture ||
          card.matches(":focus-visible") ||
          (hover.matches && card.matches(":hover"))
        )
          drift.pause();
        else drift.play();
      }

      card.addEventListener(
        "pointerdown",
        (event) => {
          if (!event.isPrimary || event.button !== 0 || gesture) return;
          suppressClick = false;
          if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
            return;
          const translation = getComputedStyle(card)
            .translate.split(" ")
            .map(parseFloat);
          const offsetX = translation[0] || 0;
          const offsetY = translation[1] || 0;
          gesture = {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            offsetX,
            offsetY,
            limits: dragSpace(card, scene),
            moved: false,
          };
          // A second grab can interrupt the previous return at its current position.
          card.style.translate = `${offsetX}px ${offsetY}px`;
          card.dataset.held = "";
          card.setPointerCapture(event.pointerId);
          sync();
        },
        options
      );

      card.addEventListener(
        "pointermove",
        (event) => {
          if (!gesture || event.pointerId !== gesture.id) return;
          const dx = event.clientX - gesture.x;
          const dy = event.clientY - gesture.y;
          if (!gesture.moved) {
            if (Math.hypot(dx, dy) < 6) return;
            if (event.pointerType === "touch" && Math.abs(dy) > Math.abs(dx))
              return;
            gesture.moved = true;
            card.dataset.dragging = "";
          }
          const { left, right, up, down } = gesture.limits;
          const x = gesture.offsetX + Math.min(right, Math.max(-left, dx));
          const y = gesture.offsetY + Math.min(down, Math.max(-up, dy));
          card.style.translate = `${x}px ${y}px`;
        },
        options
      );

      function release(event: PointerEvent) {
        if (!gesture || event.pointerId !== gesture.id) return;
        suppressClick = gesture.moved;
        gesture = null;
        delete card.dataset.held;
        delete card.dataset.dragging;
        card.style.removeProperty("translate");
        sync();
      }
      card.addEventListener("pointerup", release, options);
      card.addEventListener("pointercancel", release, options);
      card.addEventListener("lostpointercapture", release, options);
      card.addEventListener(
        "dragstart",
        (event) => {
          if (gesture) event.preventDefault();
        },
        options
      );
      card.addEventListener(
        "click",
        (event) => {
          if (suppressClick && event.detail > 0) {
            event.preventDefault();
            event.stopPropagation();
            suppressClick = false;
          }
        },
        { ...options, capture: true }
      );
      for (const name of ["pointerenter", "pointerleave", "focus", "blur"]) {
        card.addEventListener(name, sync, options);
      }
      return { drift, sync };
    }
  );

  return {
    sync(inView: boolean, prefersReducedMotion: boolean) {
      visible = inView;
      reduced = prefersReducedMotion;
      cards.forEach((card) => card.sync());
    },
    dispose() {
      listeners.abort();
      cards.forEach((card) => card.drift.cancel());
    },
  };
}
