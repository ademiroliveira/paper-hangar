import { Vector3 } from 'three';
import { Face, flatToWorld } from './geometry';
import type { Vec2 } from './types';

/**
 * References name features of the sheet so recipes read like instructions:
 *   corner:top-left | corner:top-right | corner:bottom-left | corner:bottom-right
 *   edge:top | edge:bottom | edge:left | edge:right
 *   crease:<id>          a crease made by an earlier fold
 *   mid:<line>           midpoint of an edge or crease, e.g. mid:edge:top
 *   at:<x>,<y>           a point given as fractions of the sheet, e.g. at:0.5,1
 * "top" is the far edge of the sheet in portrait, where the nose usually ends up.
 */
export interface RefContext {
  W: number;
  H: number;
  /** Flat segments of every crease made so far, by id. */
  creases: Map<string, [Vec2, Vec2][]>;
  /** Flat segments where the paper has been cut, so it no longer connects across them. */
  cuts?: [Vec2, Vec2][];
  /**
   * The sheet as it is now, in flat coordinates, once a strip has been cut off (default: the whole
   * W × H sheet). Corners, edges and at: fractions refer to it.
   */
  sheet?: Rect;
  /** Pieces cut off so far, newest last (filled in while compiling). */
  trims?: { area: number; sheet: Rect }[];
}

/** A rectangle on the flat sheet: lower-left corner and size, in cm. */
export interface Rect { x: number; y: number; w: number; h: number }
const sheetOf = (ctx: RefContext): Rect => ctx.sheet ?? { x: 0, y: 0, w: ctx.W, h: ctx.H };

export type Resolved =
  | { kind: 'point'; p: Vector3 }
  | { kind: 'line'; a: Vector3; b: Vector3 };

export class RefError extends Error {}

const CORNERS: Record<string, (r: Rect) => Vec2> = {
  'top-left': r => [r.x, r.y + r.h],
  'top-right': r => [r.x + r.w, r.y + r.h],
  'bottom-left': r => [r.x, r.y],
  'bottom-right': r => [r.x + r.w, r.y],
};
const EDGES: Record<string, (r: Rect) => [Vec2, Vec2]> = {
  top: r => [[r.x, r.y + r.h], [r.x + r.w, r.y + r.h]],
  bottom: r => [[r.x, r.y], [r.x + r.w, r.y]],
  left: r => [[r.x, r.y], [r.x, r.y + r.h]],
  right: r => [[r.x + r.w, r.y], [r.x + r.w, r.y + r.h]],
};

export const REF_PATTERN = '^(corner:(top|bottom)-(left|right)|edge:(top|bottom|left|right)|crease:[a-z0-9-]+|mid:(edge:(top|bottom|left|right)|crease:[a-z0-9-]+)|at:-?[0-9.]+,-?[0-9.]+)$';
export const isRef = (s: string) => new RegExp(REF_PATTERN).test(s);

/** Flat segments that make up a line reference. */
function flatSegments(ref: string, ctx: RefContext): [Vec2, Vec2][] {
  const [kind, name] = splitRef(ref);
  if (kind === 'edge') {
    const e = EDGES[name];
    if (!e) throw new RefError(`Unknown edge "${name}". Use top, bottom, left or right.`);
    return [e(sheetOf(ctx))];
  }
  if (kind === 'crease') {
    const segs = ctx.creases.get(name);
    if (!segs || !segs.length) {
      const known = [...ctx.creases.keys()].join(', ') || 'none yet';
      throw new RefError(`Unknown crease "${name}". Creases so far: ${known}.`);
    }
    return segs;
  }
  throw new RefError(`"${ref}" is not a line. Use edge:… or crease:…`);
}

function splitRef(ref: string): [string, string] {
  const i = ref.indexOf(':');
  if (i < 0) throw new RefError(`"${ref}" is not a reference. Expected something like corner:top-left.`);
  return [ref.slice(0, i), ref.slice(i + 1)];
}

const lenXZ = (a: Vector3, b: Vector3) => Math.hypot(a.x - b.x, a.z - b.z);

/** The spot on the flat sheet a point reference names (before any folding moves it). */
export function flatPoint(ref: string, ctx: RefContext): Vec2 {
  const [kind, name] = splitRef(ref);
  if (kind === 'corner') {
    const c = CORNERS[name];
    if (!c) throw new RefError(`Unknown corner "${name}". Use top-left, top-right, bottom-left or bottom-right.`);
    return c(sheetOf(ctx));
  }
  if (kind === 'at') {
    const [fx, fy] = name.split(',').map(Number);
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) throw new RefError(`"${ref}" needs two numbers, like at:0.5,1.`);
    const r = sheetOf(ctx);
    return [r.x + fx * r.w, r.y + fy * r.h];
  }
  if (kind === 'mid') {
    const segs = flatSegments(name, ctx);
    let best = segs[0], bestLen = -1;
    for (const s of segs) {
      const l = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
      if (l > bestLen) { bestLen = l; best = s; }
    }
    return [(best[0][0] + best[1][0]) / 2, (best[0][1] + best[1][1]) / 2];
  }
  throw new RefError(`"${ref}" is a line, but a point is needed here (corner:…, mid:…, or at:x,y).`);
}

export function resolve(ref: string, faces: Face[], ctx: RefContext): Resolved {
  const [kind, name] = splitRef(ref);
  switch (kind) {
    case 'corner':
    case 'at':
    case 'mid':
      return { kind: 'point', p: flatToWorld(flatPoint(ref, ctx), faces) };
    case 'edge':
    case 'crease': {
      // A crease can span several layers; use its longest piece as it lies right now.
      const pieces = flatSegments(ref, ctx).map(([p, q]) => [flatToWorld(p, faces), flatToWorld(q, faces)] as const);
      let best = pieces[0];
      for (const pc of pieces) if (lenXZ(pc[0], pc[1]) > lenXZ(best[0], best[1])) best = pc;
      // Every piece must still lie on that one line, or the reference is ambiguous.
      const [a, b] = best, ux = b.x - a.x, uz = b.z - a.z, ul = Math.hypot(ux, uz);
      const off = (v: Vector3) => Math.abs(((v.x - a.x) * uz - (v.z - a.z) * ux) / ul);
      if (ul > 1e-9 && pieces.some(([p, q]) => off(p) > 1e-3 || off(q) > 1e-3)) {
        throw new RefError(`"${ref}" is now in more than one place, because the layers it was made on have been folded apart. Point at another line, or give a later fold its own id.`);
      }
      return { kind: 'line', a, b };
    }
    default:
      throw new RefError(`Unknown reference type "${kind}" in "${ref}".`);
  }
}
