import { contourRidges } from "./ural-contours";

/** The same contour geometry as the cover, rendered once as static SVG. */
export function ReliefPattern({ side }: { side: 0 | 1 }) {
  const ridge = contourRidges[side];
  return (
    <svg viewBox="0 0 480 650" fill="none" aria-hidden="true" focusable="false">
      <g transform={`translate(${ridge.anchor[0]} ${ridge.anchor[1]})`}>
        {ridge.contours.map((points, index) => {
          let d = `M${points[0]},${points[1]}`;
          for (let p = 2; p < points.length; p += 6)
            d += `C${Array.from(points.subarray(p, p + 6)).join(",")}`;
          return (
            <path
              key={index}
              d={d + "Z"}
              stroke="currentColor"
              strokeWidth={index % 4 === 0 ? 1.1 : 0.65}
            />
          );
        })}
      </g>
    </svg>
  );
}
