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
}

export type Resolved =
  | { kind: 'point'; p: Vector3 }
  | { kind: 'line'; a: Vector3; b: Vector3 };

export class RefError extends Error {}

const CORNERS: Record<string, (W: number, H: number) => Vec2> = {
  'top-left': (_W, H) => [0, H],
  'top-right': (W, H) => [W, H],
  'bottom-left': () => [0, 0],
  'bottom-right': W => [W, 0],
};
const EDGES: Record<string, (W: number, H: number) => [Vec2, Vec2]> = {
  top: (W, H) => [[0, H], [W, H]],
  bottom: W => [[0, 0], [W, 0]],
  left: (_W, H) => [[0, 0], [0, H]],
  right: (W, H) => [[W, 0], [W, H]],
};

export const REF_PATTERN = '^(corner:(top|bottom)-(left|right)|edge:(top|bottom|left|right)|crease:[a-z0-9-]+|mid:(edge:(top|bottom|left|right)|crease:[a-z0-9-]+)|at:-?[0-9.]+,-?[0-9.]+)$';
export const isRef = (s: string) => new RegExp(REF_PATTERN).test(s);

/** Flat segments that make up a line reference. */
function flatSegments(ref: string, ctx: RefContext): [Vec2, Vec2][] {
  const [kind, name] = splitRef(ref);
  if (kind === 'edge') {
    const e = EDGES[name];
    if (!e) throw new RefError(`Unknown edge "${name}". Use top, bottom, left or right.`);
    return [e(ctx.W, ctx.H)];
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

export function resolve(ref: string, faces: Face[], ctx: RefContext): Resolved {
  const [kind, name] = splitRef(ref);
  switch (kind) {
    case 'corner': {
      const c = CORNERS[name];
      if (!c) throw new RefError(`Unknown corner "${name}". Use top-left, top-right, bottom-left or bottom-right.`);
      return { kind: 'point', p: flatToWorld(c(ctx.W, ctx.H), faces) };
    }
    case 'at': {
      const [fx, fy] = name.split(',').map(Number);
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) throw new RefError(`"${ref}" needs two numbers, like at:0.5,1.`);
      return { kind: 'point', p: flatToWorld([fx * ctx.W, fy * ctx.H], faces) };
    }
    case 'mid': {
      const segs = flatSegments(name, ctx);
      let best = segs[0], bestLen = -1;
      for (const s of segs) {
        const l = Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
        if (l > bestLen) { bestLen = l; best = s; }
      }
      return { kind: 'point', p: flatToWorld([(best[0][0] + best[1][0]) / 2, (best[0][1] + best[1][1]) / 2], faces) };
    }
    case 'edge':
    case 'crease': {
      // A crease can span several layers; use its longest piece as it lies right now.
      let best: Resolved | null = null, bestLen = -1;
      for (const [p, q] of flatSegments(ref, ctx)) {
        const a = flatToWorld(p, faces), b = flatToWorld(q, faces);
        const l = lenXZ(a, b);
        if (l > bestLen) { bestLen = l; best = { kind: 'line', a, b }; }
      }
      return best!;
    }
    default:
      throw new RefError(`Unknown reference type "${kind}" in "${ref}".`);
  }
}
