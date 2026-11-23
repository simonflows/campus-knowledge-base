import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contourPeriodMs,
  contourRidges,
  paintContours,
} from "../components/motion/ural-contours";

function drawing(time: number, width = 480, height = 650) {
  const points: number[] = [];
  const context = {
    clearRect() {},
    beginPath() {},
    closePath() {},
    stroke() {},
    moveTo(...values: number[]) {
      points.push(...values);
    },
    bezierCurveTo(...values: number[]) {
      points.push(...values);
    },
  } as unknown as CanvasRenderingContext2D;
  for (const ridge of contourRidges)
    paintContours(
      context,
      ridge,
      new Float32Array(ridge.contours[0].length),
      width,
      height,
      time
    );
  return points;
}

test("the contour cycle returns to the same geometry without a boundary jump", () => {
  const first = drawing(0);
  const cycle = drawing(contourPeriodMs);
  assert.ok(first.length > 100);
  assert.equal(first.length, cycle.length);
  assert.ok(
    first.every((point, index) => Math.abs(point - cycle[index]) < 0.001)
  );
  const before = drawing(contourPeriodMs - 16);
  const after = drawing(16);
  assert.ok(before.every((point, index) => Math.abs(point - after[index]) < 1));
  assert.ok(
    drawing(1400).some((point, index) => Math.abs(point - first[index]) > 1)
  );
});

test("phone edge crops preserve the geometry of both contour groups", () => {
  const base = drawing(1100);
  const phone = drawing(1100, 126, 528);
  const scale = 528 / 650;
  // Skip contour-group boundaries. Width changes the crop origin, while the
  // distance between successive points must keep the same scale on both axes.
  let start = 0;
  for (const ridge of contourRidges) {
    const end =
      start +
      ridge.contours.reduce((points, contour) => points + contour.length, 0);
    for (let i = start + 2; i < end; i++) {
      const expected = (base[i] - base[i - 2]) * scale;
      assert.ok(
        Math.abs(phone[i] - phone[i - 2] - expected) < 0.001,
        `Coordinate ${i} must use a uniform scale`
      );
    }
    start = end;
  }
});
