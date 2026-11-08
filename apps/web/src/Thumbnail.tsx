import { useMemo } from 'react';
import { projectFinal, type CompiledPlane } from '@paper-hangar/crease';

const FRONT = [251, 251, 247];
const BACK = [53, 87, 212];
const shade = (rgb: number[], light: number) => `rgb(${rgb.map(c => Math.round(c * (0.7 + 0.3 * light))).join(' ')})`;

/** A drawing of the finished plane, generated from the recipe. No artwork to make or keep in sync. */
export function Thumbnail({ plane, className }: { plane: CompiledPlane; className?: string }) {
  const { polygons, bounds } = useMemo(() => projectFinal(plane), [plane]);
  const pad = 2;
  const [x0, y0, x1, y1] = bounds;
  return (
    <svg
      className={className}
      viewBox={`${x0 - pad} ${y0 - pad} ${x1 - x0 + pad * 2} ${y1 - y0 + pad * 2}`}
      role="img"
      aria-label={`The finished ${plane.spec.name}`}
    >
      {polygons.map((p, i) => (
        <polygon
          key={i}
          points={p.points.map(q => q.join(',')).join(' ')}
          fill={shade(p.side === 'front' ? FRONT : BACK, p.light)}
          stroke="rgb(20 40 34 / 0.35)"
          strokeWidth={0.08}
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
