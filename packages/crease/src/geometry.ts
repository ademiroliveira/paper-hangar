import { Matrix4, Vector3 } from 'three';
import type { Vec2 } from './types';

export const EPS = 1e-4;

/** Flat sheet point -> table frame (X across, Y up, Z = -along). */
export const flatToLocal = (p: Vec2) => new Vector3(p[0], 0, -p[1]);

/**
 * A convex piece of the sheet. `poly` is in flat sheet coordinates (counter-clockwise),
 * `M` places it in the table frame. The front of the sheet faces +Y when M is identity.
 */
export class Face {
  poly: Vec2[];
  M: Matrix4;
  tags: Set<string>;
  /** Indices of the ops (within the current step) that move this face. Compile-time only. */
  ops = new Set<number>();
  /** The face this one was split from in the current op. Compile-time only. */
  splitFrom?: Face;

  constructor(poly: Vec2[], M?: Matrix4, tags?: Iterable<string>) {
    this.poly = poly;
    this.M = M ? M.clone() : new Matrix4();
    this.tags = new Set(tags ?? []);
  }
  world(M: Matrix4 = this.M): Vector3[] {
    return this.poly.map(p => flatToLocal(p).applyMatrix4(M));
  }
  centroidFlat(): Vec2 {
    let x = 0, y = 0;
    for (const p of this.poly) { x += p[0]; y += p[1]; }
    return [x / this.poly.length, y / this.poly.length];
  }
  centroidWorld(): Vector3 {
    const c = new Vector3();
    for (const v of this.world()) c.add(v);
    return c.multiplyScalar(1 / this.poly.length);
  }
  maxY(): number { return Math.max(...this.world().map(v => v.y)); }
  area(): number {
    let a = 0;
    for (let i = 0; i < this.poly.length; i++) {
      const p = this.poly[i], q = this.poly[(i + 1) % this.poly.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return a / 2;
  }
}

/** Split a face by the plane through p0 with normal n (both in the table frame). */
export function splitFace(face: Face, p0: Vector3, n: Vector3): Face[] {
  const d = face.world().map(w => w.sub(p0).dot(n));
  if (!(d.some(x => x > EPS) && d.some(x => x < -EPS))) return [face];
  const A: Vec2[] = [], B: Vec2[] = [], L = face.poly.length;
  for (let i = 0; i < L; i++) {
    const j = (i + 1) % L, pi = face.poly[i], pj = face.poly[j], di = d[i], dj = d[j];
    if (di >= -EPS) A.push(pi);
    if (di <= EPS) B.push(pi);
    if ((di > EPS && dj < -EPS) || (di < -EPS && dj > EPS)) {
      const s = di / (di - dj);
      const q: Vec2 = [pi[0] + (pj[0] - pi[0]) * s, pi[1] + (pj[1] - pi[1]) * s];
      A.push(q); B.push(q);
    }
  }
  return [A, B].map(poly => {
    const f = new Face(poly, face.M, face.tags);
    f.ops = new Set(face.ops);
    f.splitFrom = face.splitFrom ?? face;
    return f;
  });
}

/** Is a flat point inside (or on the edge of) a convex face? */
export function flatContains(face: Face, p: Vec2, eps = 1e-6): boolean {
  const L = face.poly.length;
  for (let i = 0; i < L; i++) {
    const a = face.poly[i], b = face.poly[(i + 1) % L];
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (cross < -eps) return false;
  }
  return true;
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b[0] - a[0], aby = b[1] - a[1];
  const L2 = abx * abx + aby * aby;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / L2)) : 0;
  return Math.hypot(p[0] - a[0] - abx * t, p[1] - a[1] - aby * t);
}

/** Where a flat point of the sheet currently is. Paper is continuous, so any face touching it agrees. */
export function flatToWorld(p: Vec2, faces: Face[]): Vector3 {
  let face = faces.find(f => flatContains(f, p));
  if (!face) {
    let best = Infinity;
    for (const f of faces) {
      let d = Infinity;
      for (let i = 0; i < f.poly.length; i++) d = Math.min(d, distToSegment(p, f.poly[i], f.poly[(i + 1) % f.poly.length]));
      if (d < best) { best = d; face = f; }
    }
  }
  return flatToLocal(p).applyMatrix4(face!.M);
}

/** The stretches of edge two faces share in flat coordinates (where the paper connects them). */
export function sharedSegments(a: Face, b: Face): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  for (let i = 0; i < a.poly.length; i++) {
    const p0 = a.poly[i], p1 = a.poly[(i + 1) % a.poly.length];
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len, uy = dy / len;
    for (let j = 0; j < b.poly.length; j++) {
      const q0 = b.poly[j], q1 = b.poly[(j + 1) % b.poly.length];
      const c0 = ux * (q0[1] - p0[1]) - uy * (q0[0] - p0[0]);
      const c1 = ux * (q1[1] - p0[1]) - uy * (q1[0] - p0[0]);
      if (Math.abs(c0) > 1e-6 || Math.abs(c1) > 1e-6) continue;
      const t0 = ux * (q0[0] - p0[0]) + uy * (q0[1] - p0[1]);
      const t1 = ux * (q1[0] - p0[0]) + uy * (q1[1] - p0[1]);
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(len, Math.max(t0, t1));
      if (hi - lo > 1e-6) out.push([[p0[0] + ux * lo, p0[1] + uy * lo], [p0[0] + ux * hi, p0[1] + uy * hi]]);
    }
  }
  return out;
}

/** Two faces share a stretch of edge in flat coordinates, i.e. the paper connects them. */
export function adjacent(a: Face, b: Face): boolean {
  const ea = a.poly.map((p, i) => [p, a.poly[(i + 1) % a.poly.length]] as const);
  const eb = b.poly.map((p, i) => [p, b.poly[(i + 1) % b.poly.length]] as const);
  for (const [p0, p1] of ea) {
    const dx = p1[0] - p0[0], dy = p1[1] - p0[1], len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    const ux = dx / len, uy = dy / len;
    for (const [q0, q1] of eb) {
      const c0 = ux * (q0[1] - p0[1]) - uy * (q0[0] - p0[0]);
      const c1 = ux * (q1[1] - p0[1]) - uy * (q1[0] - p0[0]);
      if (Math.abs(c0) > 1e-6 || Math.abs(c1) > 1e-6) continue;
      const t0 = ux * (q0[0] - p0[0]) + uy * (q0[1] - p0[1]);
      const t1 = ux * (q1[0] - p0[0]) + uy * (q1[1] - p0[1]);
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(len, Math.max(t0, t1));
      if (hi - lo > 1e-6) return true;
    }
  }
  return false;
}

/** Do two faces cover some of the same table area (seen from above)? Convex polygons, separating-axis test. */
export function overlapsFromAbove(a: Face, b: Face, eps = 1e-4): boolean {
  const pa = a.world().map(v => [v.x, v.z] as Vec2), pb = b.world().map(v => [v.x, v.z] as Vec2);
  for (const poly of [pa, pb]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const nx = q[1] - p[1], ny = p[0] - q[0], len = Math.hypot(nx, ny);
      if (len < 1e-9) continue;
      const proj = (s: Vec2[]) => s.map(r => (r[0] * nx + r[1] * ny) / len);
      const A = proj(pa), B = proj(pb);
      if (Math.max(...A) <= Math.min(...B) + eps || Math.max(...B) <= Math.min(...A) + eps) return false;
    }
  }
  return true;
}

/** Group faces into flaps: sets connected through the paper. */
export function components(faces: Face[]): Face[][] {
  const seen = new Set<Face>(), out: Face[][] = [];
  for (const f of faces) {
    if (seen.has(f)) continue;
    const comp: Face[] = [], stack = [f];
    seen.add(f);
    while (stack.length) {
      const g = stack.pop()!;
      comp.push(g);
      for (const h of faces) if (!seen.has(h) && adjacent(g, h)) { seen.add(h); stack.push(h); }
    }
    out.push(comp);
  }
  return out;
}
