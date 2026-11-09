import { Vector3 } from 'three';
import { arrowPath, faceMatrix, stepMatrices, type CompiledPlane } from './compile';
import type { Vec2 } from './types';

export interface ThumbPolygon {
  points: Vec2[];
  /** Which side of the sheet faces the viewer. */
  side: 'front' | 'back';
  /** 0..1 diffuse light, for simple shading. */
  light: number;
  /** This piece moves in the step being drawn. */
  moving: boolean;
}

export interface Projection {
  polygons: ThumbPolygon[];
  /** Fold lines (draw dashed). */
  creases: [Vec2, Vec2][];
  /** Fold arrows as polylines; the last point is the tip. */
  arrows: Vec2[][];
  bounds: [number, number, number, number];
}

export interface View { theta: number; phi: number }
export const TABLE_VIEW: View = { theta: 0, phi: 0.5 };
export const FLIGHT_VIEW: View = { theta: 0.95, phi: 1.05 };

/**
 * Draw one step as 2D shapes, back to front: the paper at progress t, plus the step's
 * fold lines and arrows. Renderer-free: an SVG, a canvas or a native view can draw it.
 */
export function projectStep(plane: CompiledPlane, index: number, t: number, view?: View): Projection {
  const step = plane.steps[index];
  const { theta, phi } = view ?? (step.view === 'flight' ? FLIGHT_VIEW : TABLE_VIEW);
  const mats = stepMatrices(step, t);
  const z = new Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta));
  const x = new Vector3().crossVectors(new Vector3(0, 1, 0), z).normalize();
  const y = new Vector3().crossVectors(z, x);
  const light = new Vector3(-0.4, 1, 0.5).normalize();
  const to2 = (v: Vector3): Vec2 => [v.dot(x), -v.dot(y)];

  const items = step.faces.map((f, i) => {
    const vs = f.world(faceMatrix(step, i, mats));
    const n = new Vector3().crossVectors(vs[1].clone().sub(vs[0]), vs[2].clone().sub(vs[0])).normalize();
    const front = n.dot(z) >= 0;
    const facing = front ? n : n.clone().negate();
    return {
      points: vs.map(to2),
      side: (front ? 'front' : 'back') as ThumbPolygon['side'],
      light: Math.min(1, Math.max(0, 0.55 + 0.45 * facing.dot(light))),
      moving: step.movingAny[i],
      depth: vs.reduce((s, v) => s + v.dot(z), 0) / vs.length,
      height: vs.reduce((s, v) => s + v.y, 0) / vs.length,
      flat: Math.abs(n.y) > 1 - 1e-6,
    };
  });
  // Stacked layers sit only GAP apart, so at an angle their average depth is decided by where they
  // lie on the table, not which is on top. When everything lies flat, seen from above, the higher
  // layer always covers the lower one: draw in height order. Otherwise fall back to depth.
  const allFlat = phi < Math.PI / 2 && items.every(it => it.flat);
  items.sort((a, b) => (allFlat ? a.height - b.height : a.depth - b.depth));

  const top = Math.max(...step.faces.map(f => f.maxY())) + 0.05;
  const creases: [Vec2, Vec2][] = t === 0
    ? step.ops.filter(op => op.crease).map(op => [to2(op.crease![0].clone().setY(top)), to2(op.crease![1].clone().setY(top))])
    : [];
  const arrows = t === 0
    ? step.ops.map((_, k) => arrowPath(step, k, 24)).filter((p): p is Vector3[] => !!p).map(p => p.map(to2))
    : [];

  const all = [...items.flatMap(p => p.points), ...arrows.flat()];
  const bounds: [number, number, number, number] = [
    Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])),
    Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1])),
  ];
  return { polygons: items.map(({ depth: _d, height: _h, flat: _f, ...p }) => p), creases, arrows, bounds };
}

/** The finished model (last step, fully folded). */
export function projectFinal(plane: CompiledPlane, view: View = FLIGHT_VIEW): Projection {
  return projectStep(plane, plane.steps.length - 1, 1, view);
}
