import { Vector3 } from 'three';
import { Face } from './geometry';
import { resolve, type RefContext } from './refs';
import type { CompiledPlane } from './compile';
import type { Vec2 } from './types';

/**
 * Read-outs of a compiled plane in plain numbers, for people and agents writing recipes.
 * Positions are "table" coordinates in cm: x to the right, y away from you, the same axes
 * as the flat sheet before anything moves. A corner that has been folded over shows where it is now.
 */

const r1 = (n: number) => Math.round(n * 10) / 10 + 0;
const table = (v: Vector3): Vec2 => [r1(v.x), r1(-v.z)];

/** Faces as they lie before step `index` (0-based): the flat sheet, or the end of the step before. */
function facesBefore(plane: CompiledPlane, index: number): Face[] {
  if (index < 0 || index > plane.steps.length) {
    throw new RangeError(`Step ${index + 1} isn't available: ${plane.steps.length} step(s) fold so far.`);
  }
  return index === 0
    ? [new Face([[0, 0], [plane.width, 0], [plane.width, plane.height], [0, plane.height]])]
    : plane.steps[index - 1].end;
}

function contextBefore(plane: CompiledPlane, index: number): RefContext {
  return {
    W: plane.width,
    H: plane.height,
    creases: new Map(plane.creases.filter(c => c.step < index).map(c => [c.id, c.segs])),
  };
}

export interface RefInfo {
  ref: string;
  kind: 'point' | 'line';
  /** Where a point is now (table cm). */
  at?: Vec2;
  /** Where a line runs now (table cm). */
  from?: Vec2;
  to?: Vec2;
  /** For creases: the step that made it (1-based). */
  madeIn?: number;
}

export interface RefsReport {
  /** The step these references are for (1-based): what you can point at when writing it. */
  step: number;
  usable: RefInfo[];
  /** References that exist but can't be used right now, and why. */
  unusable: { ref: string; reason: string }[];
}

const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const EDGES = ['top', 'bottom', 'left', 'right'];

/** Every named reference that resolves before step `index` (0-based), and where it is. */
export function refsAt(plane: CompiledPlane, index: number): RefsReport {
  const faces = facesBefore(plane, index);
  const ctx = contextBefore(plane, index);
  const made = new Map(plane.creases.map(c => [c.id, c.step + 1]));
  const candidates = [
    ...CORNERS.map(c => `corner:${c}`),
    ...EDGES.map(e => `edge:${e}`),
    ...EDGES.map(e => `mid:edge:${e}`),
    ...[...ctx.creases.keys()].flatMap(id => [`crease:${id}`, `mid:crease:${id}`]),
  ];
  const usable: RefInfo[] = [], unusable: RefsReport['unusable'] = [];
  for (const ref of candidates) {
    try {
      const r = resolve(ref, faces, ctx);
      const info: RefInfo = r.kind === 'point'
        ? { ref, kind: 'point', at: table(r.p) }
        : { ref, kind: 'line', from: table(r.a), to: table(r.b) };
      const id = ref.startsWith('crease:') ? ref.slice(7) : ref.startsWith('mid:crease:') ? ref.slice(11) : null;
      if (id && made.has(id)) info.madeIn = made.get(id);
      usable.push(info);
    } catch (e) {
      unusable.push({ ref, reason: (e as Error).message });
    }
  }
  return { step: index + 1, usable, unusable };
}

export interface FinishedMeasures {
  /** Tip to tip across the wings (cm). */
  wingspan: number;
  /** Nose to tail (cm). */
  length: number;
  /** How far the body hangs below the wings (cm). */
  bodyDepth: number;
  /** Top to bottom of the whole plane (cm). */
  height: number;
}

export interface StateReport {
  /** The step just finished (1-based). */
  step: number;
  title: string;
  view: 'table' | 'flight';
  pieces: number;
  /** Table steps: how many layers of paper are stacked at the thickest point. */
  maxLayers?: number;
  /** Table steps: size of the folded shape on the table (cm), and its outline corners. */
  size?: { width: number; depth: number };
  /** Table steps: share of the paper (by area) whose front side faces up, 0..1. */
  frontUp?: number;
  /** Table steps: the uppermost layer, which a `layers: "top"` fold would take. */
  topLayer?: { side: 'front' | 'back'; centerOnSheet: Vec2 };
  /** Where each corner of the sheet is now (table cm). */
  corners: Record<string, Vec2>;
  /** Creases that exist after this step, with the step that made each. */
  creases: { id: string; madeIn: number; named: boolean }[];
  /** Flight steps: the finished plane's measurements. */
  measures?: FinishedMeasures;
}

/** Point-in-convex-polygon, both in table coordinates. */
function contains(poly: Vec2[], x: number, y: number) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    // Points on an edge belong to no face: two faces meeting at a crease are one layer, not two.
    if (Math.abs(c) < 1e-6) return false;
    const s = Math.sign(c);
    if (sign && s !== sign) return false;
    sign = s;
  }
  return true;
}

const normalUp = (f: Face) => {
  const v = f.world();
  return new Vector3().crossVectors(v[1].clone().sub(v[0]), v[2].clone().sub(v[0])).y;
};

/** Measure the finished plane in its flight pose (the last step must be a pose). */
export function measureFinished(plane: CompiledPlane): FinishedMeasures | null {
  const last = plane.steps.at(-1);
  if (!last || last.view !== 'flight') return null;
  const pose = plane.spec.steps[last.index].pose!;
  const wing = (f: Face) => pose.wings.some(id => f.tags.has(`moved:${id}`));
  const all = last.end.flatMap(f => f.world());
  const body = last.end.filter(f => !wing(f)).flatMap(f => f.world());
  const ext = (vs: Vector3[], k: 'x' | 'y' | 'z') => {
    const xs = vs.map(v => v[k]);
    return r1(Math.max(...xs) - Math.min(...xs));
  };
  // The flight pose points the nose along -z, with y up.
  return { wingspan: ext(all, 'x'), length: ext(all, 'z'), bodyDepth: ext(body.length ? body : all, 'y'), height: ext(all, 'y') };
}

/** The paper after step `index` (0-based), in numbers. */
export function describeAfter(plane: CompiledPlane, index: number): StateReport {
  const st = plane.steps[index];
  if (!st) throw new RangeError(`Step ${index + 1} isn't available: ${plane.steps.length} step(s) fold so far.`);
  const faces = st.end;
  const W = plane.width, H = plane.height;
  const corners: Record<string, Vec2> = {};
  const ctx = contextBefore(plane, index + 1);
  for (const c of CORNERS) {
    const r = resolve(`corner:${c}`, faces, ctx);
    if (r.kind === 'point') corners[c] = table(r.p);
  }
  const report: StateReport = {
    step: index + 1,
    title: st.title,
    view: st.view,
    pieces: faces.length,
    corners,
    creases: plane.creases.filter(c => c.step <= index).map(c => ({ id: c.id, madeIn: c.step + 1, named: c.named })),
  };
  if (st.view === 'flight') {
    report.measures = measureFinished({ ...plane, steps: plane.steps.slice(0, index + 1) }) ?? undefined;
    return report;
  }
  const polys = faces.map(f => f.world().map((v): Vec2 => [v.x, -v.z]));
  const pts = polys.flat();
  const minX = Math.min(...pts.map(p => p[0])), maxX = Math.max(...pts.map(p => p[0]));
  const minY = Math.min(...pts.map(p => p[1])), maxY = Math.max(...pts.map(p => p[1]));
  let maxLayers = 0;
  const N = 48;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    // Off-centre samples, so they don't line up with creases at simple fractions of the sheet.
    const x = minX + ((maxX - minX) * (i + 0.513)) / (N + 1), y = minY + ((maxY - minY) * (j + 0.487)) / (N + 1);
    maxLayers = Math.max(maxLayers, polys.filter(p => contains(p, x, y)).length);
  }
  const total = W * H;
  const up = faces.reduce((s, f) => s + (normalUp(f) > 0 ? f.area() : 0), 0);
  const top = faces.reduce((a, b) => (b.maxY() > a.maxY() ? b : a));
  report.maxLayers = maxLayers;
  report.size = { width: r1(maxX - minX), depth: r1(maxY - minY) };
  report.frontUp = Math.round((up / total) * 100) / 100;
  report.topLayer = { side: normalUp(top) > 0 ? 'front' : 'back', centerOnSheet: top.centroidFlat().map(r1) as Vec2 };
  return report;
}
