import { Vector3 } from 'three';
import { faceMatrix, stepMatrices, type CompiledPlane } from './compile';
import type { Vec2 } from './types';

export interface ThumbPolygon {
  points: Vec2[];
  /** Which side of the sheet faces the viewer. */
  side: 'front' | 'back';
  /** 0..1 diffuse light, for simple shading. */
  light: number;
}

/**
 * Project the finished model (last step, fully folded) to 2D polygons, back to front.
 * Renderer-free: an SVG, a canvas or a native view can draw it.
 */
export function projectFinal(plane: CompiledPlane, view = { theta: 0.95, phi: 1.05 }): { polygons: ThumbPolygon[]; bounds: [number, number, number, number] } {
  const step = plane.steps[plane.steps.length - 1];
  const mats = stepMatrices(step, 1);
  const { theta, phi } = view;
  const z = new Vector3(Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta));
  const x = new Vector3().crossVectors(new Vector3(0, 1, 0), z).normalize();
  const y = new Vector3().crossVectors(z, x);
  const light = new Vector3(-0.4, 1, 0.5).normalize();

  const items = step.faces.map((f, i) => {
    const vs = f.world(faceMatrix(step, i, mats));
    const n = new Vector3().crossVectors(vs[1].clone().sub(vs[0]), vs[2].clone().sub(vs[0])).normalize();
    const front = n.dot(z) >= 0;
    const facing = front ? n : n.clone().negate();
    return {
      points: vs.map(v => [v.dot(x), -v.dot(y)] as Vec2),
      side: (front ? 'front' : 'back') as ThumbPolygon['side'],
      light: Math.min(1, Math.max(0, 0.55 + 0.45 * facing.dot(light))),
      depth: vs.reduce((s, v) => s + v.dot(z), 0) / vs.length,
    };
  });
  items.sort((a, b) => a.depth - b.depth);
  const all = items.flatMap(p => p.points);
  const bounds: [number, number, number, number] = [
    Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])),
    Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1])),
  ];
  return { polygons: items.map(({ points, side, light }) => ({ points, side, light })), bounds };
}
