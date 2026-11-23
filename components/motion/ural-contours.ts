const scales = [
  0.43, 0.53, 0.63, 0.74, 0.84, 0.93, 1.02, 1.13, 1.25, 1.37, 1.5,
];

const contourWidth = 480;
const contourHeight = 650;
export const contourPeriodMs = 24_000;

type Outline = readonly [
  start: readonly [x: number, y: number],
  ...curves: readonly (readonly [
    number,
    number,
    number,
    number,
    number,
    number,
  ])[],
];

type Ridge = {
  edge: "left" | "right";
  anchor: readonly [number, number];
  tilt: number;
  phase: number;
  strength: number;
  outline: Outline;
};

// Each outline contains a start point followed by cubic Bézier control points.
const ridges: readonly Ridge[] = [
  {
    edge: "left",
    anchor: [76, 514],
    tilt: 31,
    phase: 0.42,
    strength: 0.76,
    outline: [
      [-23, -249],
      [26, -251, 68, -213, 67, -160],
      [66, -113, 114, -91, 137, -39],
      [158, 2, 129, 35, 115, 74],
      [100, 119, 139, 157, 100, 206],
      [61, 257, -1, 253, -37, 205],
      [-68, 164, -107, 157, -119, 110],
      [-131, 59, -80, 34, -87, -12],
      [-93, -58, -136, -84, -114, -130],
      [-95, -169, -66, -173, -66, -206],
      [-66, -235, -46, -248, -23, -249],
    ],
  },
  {
    edge: "right",
    anchor: [415, 239],
    tilt: -26,
    phase: 2.28,
    strength: 1,
    outline: [
      [17, -283],
      [64, -267, 43, -222, 78, -198],
      [117, -171, 145, -152, 141, -106],
      [138, -63, 104, -46, 112, -10],
      [121, 32, 171, 54, 170, 98],
      [167, 151, 109, 164, 81, 204],
      [53, 244, 56, 274, 8, 288],
      [-40, 300, -61, 251, -85, 214],
      [-112, 173, -151, 164, -152, 118],
      [-153, 72, -118, 58, -125, 17],
      [-133, -25, -166, -57, -149, -102],
      [-130, -148, -85, -145, -69, -188],
      [-54, -227, -39, -301, 17, -283],
    ],
  },
];

export const contourRidges = ridges.map(({ tilt, outline, ...ridge }) => {
  const radians = (tilt * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const coordinates = outline.flat();
  const contours = scales.map((scale) => {
    const points = new Float32Array(coordinates.length);
    for (let index = 0; index < coordinates.length; index += 2) {
      const x = coordinates[index];
      const y = coordinates[index + 1];
      points[index] = (x * cosine - y * sine) * scale;
      points[index + 1] = (x * sine + y * cosine) * scale;
    }
    return points;
  });
  return { ...ridge, contours };
});

type ContourRidge = (typeof contourRidges)[number];

export function paintContours(
  context: CanvasRenderingContext2D,
  ridge: ContourRidge,
  points: Float32Array,
  width: number,
  height: number,
  elapsed: number | null
) {
  context.clearRect(0, 0, width, height);
  const phase =
    ridge.phase + (elapsed ?? 0) * ((2 * Math.PI) / contourPeriodMs);
  const deformation = elapsed === null ? 0 : 1;
  const scale = Math.max(width / contourWidth, height / contourHeight);
  const excessWidth = width - contourWidth * scale;
  const left = ridge.edge === "left";
  const offsetX = excessWidth * (left ? 0.16 : 0.84);
  const offsetY = left ? height - contourHeight * scale : 0;
  const [anchorX, anchorY] = ridge.anchor;
  context.strokeStyle = "#8ab4ca";

  ridge.contours.forEach((contour, index) => {
    // The crest travels from the inner to the outer lines. The position-dependent
    // waves bend each line, and the harmonics agree at both ends of the period.
    const crest = 2 * phase - index * 0.47;
    const swell =
      1 + deformation * (0.028 * Math.sin(phase) + 0.018 * Math.sin(crest));
    for (let point = 0; point < contour.length; point += 2) {
      const x = contour[point];
      const y = contour[point + 1];
      const waveX =
        15 * Math.sin(y / 69 - 2 * phase) + 6 * Math.sin((x + y) / 100 + phase);
      const waveY =
        13 * Math.sin(x / 71 + 2 * phase) + 7 * Math.cos(y / 89 - 3 * phase);
      points[point] =
        offsetX + (anchorX + x * swell + deformation * waveX) * scale;
      points[point + 1] =
        offsetY + (anchorY + y * swell + deformation * waveY) * scale;
    }

    context.beginPath();
    context.moveTo(points[0], points[1]);
    for (let i = 2; i < contour.length; i += 6) {
      context.bezierCurveTo(
        points[i],
        points[i + 1],
        points[i + 2],
        points[i + 3],
        points[i + 4],
        points[i + 5]
      );
    }
    context.closePath();
    const indexLine = index % 4 === 0;
    context.lineWidth = indexLine ? 0.95 : 0.7;
    context.globalAlpha =
      ridge.strength *
      ((indexLine ? 0.35 : 0.21) + 0.04 * deformation * Math.cos(crest));
    context.stroke();
  });
}
