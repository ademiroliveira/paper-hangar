import { useMemo } from 'react';
import type { Projection } from '@paper-hangar/crease';

const FRONT = [251, 251, 247], BACK = [53, 87, 212];
const FRONT_GLOW = [255, 214, 192], BACK_GLOW = [125, 151, 255];
const shade = (rgb: number[], light: number) => `rgb(${rgb.map(c => Math.round(c * (0.7 + 0.3 * light))).join(' ')})`;

/** Draws a projected step: paper, dashed fold lines and fold arrows, in the same visual language as the 3D view. */
export function Diagram({ projection, label, className, highlight = false }: {
  projection: Projection;
  label: string;
  className?: string;
  /** Tint the paper that moves in this step. */
  highlight?: boolean;
}) {
  const { polygons, creases, arrows, bounds } = projection;
  const [x0, y0, x1, y1] = bounds;
  const pad = 2;
  const size = Math.max(x1 - x0, y1 - y0);
  const stroke = size / 260;
  const id = useMemo(() => `ah-${Math.random().toString(36).slice(2)}`, []);
  return (
    <svg className={className} viewBox={`${x0 - pad} ${y0 - pad} ${x1 - x0 + pad * 2} ${y1 - y0 + pad * 2}`} role="img" aria-label={label}>
      <defs>
        <marker id={id} viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" fill="var(--color-mark)" />
        </marker>
      </defs>
      {polygons.map((p, i) => {
        const glow = highlight && p.moving;
        const rgb = p.side === 'front' ? (glow ? FRONT_GLOW : FRONT) : (glow ? BACK_GLOW : BACK);
        return (
          <polygon
            key={i}
            points={p.points.map(q => q.join(',')).join(' ')}
            fill={shade(rgb, p.light)}
            stroke="rgb(20 40 34 / 0.35)"
            strokeWidth={stroke}
            strokeLinejoin="round"
          />
        );
      })}
      {creases.map(([a, b], i) => (
        <line key={`c${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="var(--color-mark)" strokeWidth={stroke * 2.2} strokeDasharray={`${size / 40} ${size / 70}`} />
      ))}
      {arrows.map((pts, i) => (
        <polyline
          key={`a${i}`}
          points={pts.map(q => q.join(',')).join(' ')}
          fill="none"
          stroke="var(--color-mark)"
          strokeWidth={stroke * 3}
          strokeLinecap="round"
          strokeLinejoin="round"
          markerEnd={`url(#${id})`}
        />
      ))}
    </svg>
  );
}
