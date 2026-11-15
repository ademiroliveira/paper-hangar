import { Matrix4, Vector3 } from 'three';
import { EPS, Face, components, flatContains, flatToLocal, overlapsFromAbove, sharedSegments, splitFace } from './geometry';
import { RefError, flatPoint, resolve, type RefContext, type Resolved } from './refs';
import type { FoldSpec, PaperSpec, PlaneSpec, PoseSpec, StepSpec, Vec2 } from './types';
import { validatePlane } from './validate';
import { auditStep, type AuditIssue } from './audit';

/** Visual paper thickness between stacked layers (cm). */
export const GAP = 0.02;
const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);
const DEG = Math.PI / 180;

export type Profile = (t: number) => number;
export const linear: Profile = t => t;
export const thereAndBack: Profile = t => (t < 0.55 ? t / 0.55 : Math.max(0, (1 - t) / 0.45));
const smooth = (x: number) => x * x * (3 - 2 * x);
export const range = (a: number, b: number): Profile => t => smooth(Math.min(1, Math.max(0, (t - a) / (b - a))));

/**
 * One rigid motion inside a step: rotate some faces about an axis, optionally translate.
 * `reverse` ops turn one layer of a pocket inside out;
 * `lift` raises the whole model while a step moves; `cut` moves nothing and marks where to cut;
 * `settle` lets layers drop onto the paper right under them at the end of a step.
 */
export interface Op {
  kind: 'fold' | 'flip' | 'pose' | 'reverse' | 'lift' | 'cut' | 'settle';
  id?: string;
  /** Ops that move one piece of paper together (the layers of a reverse fold). Seams between them may open mid-motion. */
  group?: string;
  pivot: Vector3;
  axis: Vector3;
  angle: number;
  tr: Vector3 | null;
  lift: Vector3;
  prof: Profile;
  /** Per face of the step: does this op move it? */
  moving: boolean[];
  /** The fold line to draw, in the table frame at the start of the step. */
  crease: [Vector3, Vector3] | null;
  /** Whether to draw a fold arrow; it traces progress from 0 to arrowEnd. */
  arrow: boolean;
  arrowEnd: number;
  /** Lift the moving paper this high mid-motion so it clears the table (used by flips). */
  hop?: number;
}

export interface Step {
  index: number;
  title: string;
  text: string;
  view: 'table' | 'flight';
  /** Faces at the start of the step, already split along this step's creases. */
  faces: Face[];
  ops: Op[];
  movingAny: boolean[];
  /** Faces at the end of the step (the next step starts here). */
  end: Face[];
}

/** A crease made by a fold, with the step that made it (0-based). Unnamed folds get ids like `s3`. */
export interface CreaseRecord { id: string; step: number; named: boolean; segs: [Vec2, Vec2][] }

export interface CompiledPlane {
  spec: PlaneSpec;
  width: number;
  height: number;
  /** Every crease made so far, in order. */
  creases: CreaseRecord[];
  /** How high the finished plane floats above the table in the flight pose (cm). */
  flyHeight: number;
  /** Flat segments where the paper has been cut. */
  cuts: [Vec2, Vec2][];
  steps: Step[];
  done: { title: string; text: string };
}

export class PlaneError extends Error {
  /** `message` without the "Step N: " prefix. */
  readonly detail: string;
  constructor(
    public step: number | null,
    message: string,
    /** When physical checks failed: every problem found in that step, not just the first. */
    public issues: AuditIssue[] = [],
  ) {
    super(step == null ? message : `Step ${step + 1}: ${message}`);
    this.detail = message;
  }
}

export function paperSize(p: PaperSpec): { W: number; H: number } {
  if (p === 'A4') return { W: 21, H: 29.7 };
  if (p === 'Letter') return { W: 21.59, H: 27.94 };
  return { W: p.width, H: p.height };
}

/* ---------- motion ---------- */

export function opMatrix(op: Op, f: number): Matrix4 {
  // Folds and flips land their stack on top of what's below. Easing the lift with the turn
  // ((1 - cos) / 2 instead of linear) keeps every layer above the paper beneath it the whole way.
  const s = op.kind === 'pose' ? f : (1 - Math.cos(Math.PI * f)) / 2;
  const tr = op.tr ? op.tr.clone().multiplyScalar(s) : new Vector3();
  if (op.hop) tr.y += op.hop * Math.sin(Math.PI * f);
  const m = new Matrix4().makeTranslation(op.pivot.x + tr.x, op.pivot.y + tr.y, op.pivot.z + tr.z);
  m.multiply(new Matrix4().makeRotationAxis(op.axis, op.angle * f));
  m.multiply(new Matrix4().makeTranslation(-op.pivot.x, -op.pivot.y, -op.pivot.z));
  return m;
}
/** Matrices for every op of a step at progress t (0..1). */
export const stepMatrices = (step: Step, t: number) => step.ops.map(op => opMatrix(op, op.prof(t)));
/** Where face i of a step is at the progress the matrices were made for. */
export function faceMatrix(step: Step, i: number, mats: Matrix4[]): Matrix4 {
  const M = step.faces[i].M.clone();
  step.ops.forEach((op, k) => { if (op.moving[i]) M.premultiply(mats[k]); });
  return M;
}

/* ---------- building ops ---------- */

const xz = (v: Vector3) => new Vector3(v.x, 0, v.z);
const distXZ = (a: Vector3, b: Vector3) => Math.hypot(a.x - b.x, a.z - b.z);
const pointOf = (r: Resolved): Vector3 => (r.kind === 'point' ? r.p : r.a.clone().add(r.b).multiplyScalar(0.5));

interface Line { a: Vector3; b: Vector3; mover: Vector3 }

function makeOp(line: Line, o: { kind: Op['kind']; id?: string; angle: number; prof?: Profile; h?: number; lift?: Vector3 }) {
  const h = o.h ?? 0, lift = o.lift ?? UP;
  const pa = new Vector3(line.a.x, h, line.a.z), pb = new Vector3(line.b.x, h, line.b.z);
  const r = new Vector3(line.mover.x, h, line.mover.z);
  const axis = pb.clone().sub(pa).normalize();
  const n = new Vector3().crossVectors(axis, lift).normalize();
  const dist = r.clone().sub(pa).dot(n);
  if (!(Math.abs(dist) > 1e-4)) {
    throw new RefError('The part that should move lies on the fold line, so the fold has no side to move. Check that "bring" and "to" are different.');
  }
  const side = Math.sign(dist);
  // Turn so the moving side rises toward `lift`. Rotating the n side about `axis` heads toward -lift,
  // so flip the axis when the moving side is +n. One sign decides both side and direction.
  if (side > 0) axis.negate();
  const prof = o.prof ?? linear;
  const op: Op = {
    kind: o.kind, id: o.id, pivot: pa, axis, angle: o.angle * DEG, tr: null, lift, prof,
    moving: [], crease: null, arrow: o.kind !== 'pose', arrowEnd: prof === thereAndBack ? 0.55 : 1,
  };
  const onSide = (f: Face) => Math.sign(f.centroidWorld().sub(pa).dot(n)) === side;
  return { op, n, onSide };
}

/** Turn a fold described in words into a crease line on the table. */
function solveFold(f: FoldSpec, faces: Face[], ctx: RefContext): Line {
  if (f.line) {
    if (!f.move) throw new RefError('A fold on a "line" also needs "move": a point on the side that moves.');
    const a = xz(pointOf(resolve(f.line[0], faces, ctx))), b = xz(pointOf(resolve(f.line[1], faces, ctx)));
    if (a.distanceTo(b) < 1e-3) throw new RefError(`"${f.line[0]}" and "${f.line[1]}" are in the same place, so they don't make a line.`);
    return { a, b, mover: pointOf(resolve(f.move, faces, ctx)) };
  }
  if (f.along) {
    const L = resolve(f.along, faces, ctx);
    if (L.kind !== 'line') throw new RefError(`"along" needs a line (edge:… or crease:…), got "${f.along}".`);
    if (!f.move) throw new RefError('A fold "along" a line also needs "move": a point on the side that moves.');
    return { a: L.a, b: L.b, mover: pointOf(resolve(f.move, faces, ctx)) };
  }
  if (f.parallel) {
    const L = resolve(f.parallel, faces, ctx);
    if (L.kind !== 'line') throw new RefError(`"parallel" needs a line (edge:… or crease:…), got "${f.parallel}".`);
    if (!f.move) throw new RefError('A "parallel" fold also needs "move": a point on the side that moves.');
    if (!(typeof f.distance === 'number' && f.distance > 0)) throw new RefError('A "parallel" fold needs "distance": how far from the line, in cm.');
    const M = xz(pointOf(resolve(f.move, faces, ctx)));
    const a = xz(L.a), dir = xz(L.b).sub(a).normalize();
    const nrm = new Vector3(-dir.z, 0, dir.x);
    const side = Math.sign(M.clone().sub(a).dot(nrm));
    if (side === 0) throw new RefError(`"${f.move}" lies on "${f.parallel}", so it doesn't say which side moves.`);
    const p0 = a.clone().addScaledVector(nrm, side * f.distance);
    return { a: p0, b: p0.clone().add(dir), mover: M };
  }
  if (!f.bring || !f.to) throw new RefError('A fold needs "bring" and "to", "along" and "move", or "parallel", "distance" and "move".');
  const A = resolve(f.bring, faces, ctx), B = resolve(f.to, faces, ctx);

  const bisector = (p: Vector3, q: Vector3): Line => {
    const mid = xz(p).add(xz(q)).multiplyScalar(0.5);
    const d = xz(q).sub(xz(p));
    if (d.length() < 1e-6) throw new RefError(`"${f.bring}" is already at "${f.to}", so there's nothing to fold.`);
    const perp = new Vector3(-d.z, 0, d.x).normalize();
    return { a: mid, b: mid.clone().add(perp), mover: xz(p) };
  };

  if (A.kind === 'point' && B.kind === 'point') return bisector(A.p, B.p);

  if (A.kind === 'point' && B.kind === 'line') {
    if (!f.through) throw new RefError('Bringing a point onto a line also needs "through": a point the fold passes through.');
    const R = xz(pointOf(resolve(f.through, faces, ctx)));
    const P = xz(A.p), a = xz(B.a), b = xz(B.b);
    const len = a.distanceTo(b), d = b.clone().sub(a).normalize();
    const r = R.distanceTo(P), f0 = a.clone().sub(R);
    const bq = f0.dot(d), cq = f0.lengthSq() - r * r, disc = bq * bq - cq;
    if (disc < 0) throw new RefError(`"${f.bring}" can't reach "${f.to}" with a fold through "${f.through}".`);
    const cands = [-bq - Math.sqrt(disc), -bq + Math.sqrt(disc)]
      .map(t => ({ t, p: a.clone().addScaledVector(d, t) }))
      .filter(c => c.p.distanceTo(P) > 1e-6);
    if (!cands.length) throw new RefError(`"${f.bring}" is already on "${f.to}".`);
    const inside = cands.filter(c => c.t >= -0.01 * len && c.t <= 1.01 * len);
    const pick = (inside.length ? inside : cands).sort((u, v) => Math.abs(u.t - len / 2) - Math.abs(v.t - len / 2))[0];
    return bisector(P, pick.p);
  }

  if (A.kind === 'line' && B.kind === 'line') {
    const a0 = xz(A.a), a1 = xz(A.b), b0 = xz(B.a), b1 = xz(B.b);
    const uA = a1.clone().sub(a0).normalize(), uB = b1.clone().sub(b0).normalize();
    const cross = uA.x * uB.z - uA.z * uB.x;
    const midA = a0.clone().add(a1).multiplyScalar(0.5);
    if (Math.abs(cross) < 1e-6) {
      const proj = b0.clone().addScaledVector(uB, a0.clone().sub(b0).dot(uB));
      if (a0.distanceTo(proj) < 1e-4) throw new RefError(`"${f.bring}" already lies along "${f.to}", so there's nothing to fold.`);
      const mid = a0.clone().add(proj).multiplyScalar(0.5);
      return { a: mid, b: mid.clone().add(uA), mover: midA };
    }
    // intersection X of the two lines
    const w = b0.clone().sub(a0);
    const tA = (w.x * uB.z - w.z * uB.x) / cross;
    const X = a0.clone().addScaledVector(uA, tA);
    const far = (p: Vector3, q: Vector3) => (p.distanceTo(X) > q.distanceTo(X) ? p : q);
    const fA = far(a0, a1), fB = far(b0, b1);
    for (const dir of [uA.clone().add(uB), uA.clone().sub(uB)]) {
      if (dir.lengthSq() < 1e-12) continue;
      dir.normalize();
      const nrm = new Vector3(-dir.z, 0, dir.x);
      const sA = fA.clone().sub(X).dot(nrm), sB = fB.clone().sub(X).dot(nrm);
      if (sA * sB < 0) return { a: X, b: X.clone().add(dir), mover: fA };
    }
    throw new RefError(`Couldn't find a fold that brings "${f.bring}" onto "${f.to}".`);
  }
  throw new RefError(`Can't bring a line ("${f.bring}") onto a point ("${f.to}"). Swap them, or use a line target.`);
}

/**
 * Lift folded faces so they land just above the paper they cover, and no higher.
 * Paper elsewhere on the table doesn't matter: lifting over it would leave gaps between layers
 * that show once the plane stands up. Earlier folds in the same step count as paper too.
 */
function land(ops: Op[], faces: Face[]) {
  const obstacles: Face[] = faces.filter((_, i) => !ops.some(op => op.moving[i]));
  for (const op of ops) {
    if (op.angle < 170 * DEG || op.kind === 'pose') continue;
    const turn = opMatrix({ ...op, tr: null, hop: undefined }, 1);
    const landed: Face[] = [];
    faces.forEach((f, i) => { if (op.moving[i]) landed.push(new Face(f.poly, f.M.clone().premultiply(turn))); });
    const low = (f: Face) => Math.min(...f.world().map(v => v.dot(op.lift)));
    const high = (f: Face) => Math.max(...f.world().map(v => v.dot(op.lift)));
    // Never below the table, and above everything it lands on.
    let lift = Math.max(0, ...landed.map(f => -low(f)));
    for (const m of landed) for (const s of obstacles) {
      if (overlapsFromAbove(m, s)) lift = Math.max(lift, high(s) + GAP - low(m));
    }
    op.tr = op.lift.clone().multiplyScalar(lift);
    const end = new Matrix4().makeTranslation(op.tr.x, op.tr.y, op.tr.z);
    for (const m of landed) obstacles.push(new Face(m.poly, m.M.clone().premultiply(end)));
  }
}

function finish(index: number, spec: StepSpec, view: Step['view'], faces: Face[], ops: Op[]): Step {
  const step: Step = {
    index, title: spec.title, text: spec.text ?? '', view, faces, ops,
    // Lifting the model out of the way, or layers settling, isn't part of the fold; don't highlight it.
    movingAny: faces.map((_, i) => ops.some(op => op.kind !== 'lift' && op.kind !== 'settle' && op.moving[i])),
    end: [],
  };
  const mats = stepMatrices(step, 1);
  step.end = faces.map((f, i) => {
    const nf = new Face(f.poly, faceMatrix(step, i, mats), f.tags);
    ops.forEach(op => { if (op.moving[i] && op.id) nf.tags.add(`moved:${op.id}`); });
    return nf;
  });
  return step;
}

/**
 * Let every layer drop onto the paper right under it, keeping which layer is above which.
 * Without this, a flap folded over a thick part of the model keeps that thickness as gaps
 * wherever it lies on fewer layers, and the gaps grow fold after fold until the layers
 * visibly come apart once the plane stands up. Adds the drop as a short last move of the step.
 */
function settle(step: Step) {
  const end = step.end;
  const order = end.map((_, i) => i).sort((a, b) => end[a].maxY() - end[b].maxY());
  const h: number[] = new Array(end.length).fill(0);
  const placed: number[] = [];
  for (const i of order) {
    for (const j of placed) if (overlapsFromAbove(end[i], end[j])) h[i] = Math.max(h[i], h[j] + GAP);
    placed.push(i);
  }
  const groups = new Map<number, number[]>();
  end.forEach((f, i) => {
    const dy = Math.round((h[i] - f.maxY()) / (GAP / 64)) * (GAP / 64);
    if (Math.abs(dy) < GAP / 128) return;
    if (!groups.has(dy)) groups.set(dy, []);
    groups.get(dy)!.push(i);
  });
  for (const [dy, idx] of groups) {
    const set = new Set(idx);
    step.ops.push({
      kind: 'settle', pivot: new Vector3(), axis: UP.clone(), angle: 0, tr: new Vector3(0, dy, 0), lift: UP,
      prof: range(0.8, 1), moving: step.faces.map((_, i) => set.has(i)), crease: null, arrow: false, arrowEnd: 1,
    });
    for (const i of idx) end[i].M.premultiply(new Matrix4().makeTranslation(0, dy, 0));
  }
}

/* ---------- step kinds ---------- */

/** Paper lying above or between layers that lift has to lift too, even when it only connects to them on the other side of the fold (e.g. a corner flap tucked inside a wing). */
function growTrapped(chosen: Set<Face>, comps: Face[][]) {
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of comps) {
      if (c.some(x => chosen.has(x))) continue;
      const trapped = c.some(x => [...chosen].some(g => x.maxY() > g.maxY() + GAP / 2 && overlapsFromAbove(x, g)));
      if (trapped) { c.forEach(x => chosen.add(x)); grew = true; }
    }
  }
}

const layerKey = (y: number) => Math.round(y / (GAP / 8));

/**
 * Inside reverse fold: the chosen paper is a pocket. Its upper half turns down and its lower half
 * turns up, both about the fold line, so the point ends up inside the pocket, between its two sides.
 * Each layer gets its own op so the layers nest in order. Returns the ops (not yet pushed).
 */
function reverseOps(line: Line, id: string, chosen: Face[], faces: Face[]): { ops: Op[]; layerOf: Map<Face, number> } {
  const levels = [...new Set(chosen.map(f => layerKey(f.maxY())))].sort((a, b) => a - b);
  if (levels.length < 2 || levels.length % 2) {
    throw new RefError(`An inside reverse fold needs a pocket: the same number of layers on each side. The paper here has ${levels.length} layer${levels.length === 1 ? '' : 's'}.`);
  }
  const k = levels.length / 2;
  const heightOf = (lv: number) => Math.max(...chosen.filter(f => layerKey(f.maxY()) === lv).map(f => f.maxY()));
  const lo = heightOf(levels[k - 1]), hi = heightOf(levels[k]);
  const lower = chosen.filter(f => layerKey(f.maxY()) <= levels[k - 1]), upper = chosen.filter(f => layerKey(f.maxY()) >= levels[k]);
  if (!lower.some(a => upper.some(b => sharedSegments(a, b).length))) {
    throw new RefError('An inside reverse fold needs a pocket: the layers on the moving side have to be joined along a fold. These aren\'t.');
  }
  const delta = (hi - lo) / (levels.length + 1);
  const ops: Op[] = [];
  const layerOf = new Map<Face, number>();
  levels.forEach((lv, j) => {
    const y = heightOf(lv);
    const isUpper = j >= k;
    // Lower half: its top layer lands just above the pocket floor; upper half: its bottom layer just under the roof.
    const target = isUpper ? hi - (j - k + 1) * delta : lo + (k - j) * delta;
    const { op } = makeOp(line, { kind: 'reverse', id, angle: 180, h: (y + target) / 2, lift: isUpper ? DOWN : UP });
    op.group = id;
    op.arrow = j === k - 1;
    op.tr = new Vector3(0, 0, 0);
    ops.push(op);
    for (const f of chosen) if (layerKey(f.maxY()) === lv) layerOf.set(f, ops.length - 1);
  });
  // Nothing else may lie inside the pocket where the point turns in.
  const M = new Matrix4();
  for (const st of faces) {
    if (chosen.includes(st)) continue;
    const h = st.maxY();
    if (h <= lo + GAP / 8 || h >= hi - GAP / 8) continue;
    for (const f of chosen) {
      M.copy(f.M).premultiply(opMatrix(ops[layerOf.get(f)!], 1));
      if (overlapsFromAbove(new Face(f.poly, M), st)) {
        throw new RefError(`The point would turn in through paper lying inside the pocket, near (${st.centroidFlat().map(v => v.toFixed(1)).join(', ')}) cm on the flat sheet.`);
      }
    }
  }
  return { ops, layerOf };
}

function compileFolds(spec: StepSpec, index: number, start: Face[], ctx: RefContext): Step {
  const folds = spec.folds ?? [spec.fold!];
  const lines = folds.map(f => solveFold(f, start, ctx));
  let faces = start.map(f => new Face(f.poly, f.M, f.tags));
  const ops: Op[] = [];

  folds.forEach((f, k) => {
    const id = f.id ?? (folds.length > 1 ? `s${index + 1}-${k + 1}` : `s${index + 1}`);
    if (f.reverse && f.unfold) throw new RefError('A reverse fold can\'t be unfolded in the same step.');
    const { op, n, onSide } = makeOp(lines[k], {
      kind: 'fold', id, angle: f.unfold ? 175 : 180, prof: f.unfold ? thereAndBack : linear,
    });
    faces.forEach(fc => { fc.splitFrom = undefined; });
    const split = faces.flatMap(fc => splitFace(fc, op.pivot, n));
    const moving = split.filter(onSide);
    let chosen = new Set(moving);
    if (f.flap && moving.length) {
      const fp = flatPoint(f.flap, ctx);
      const comps = components(moving, ctx.cuts);
      const hit = comps.filter(c => c.some(x => flatContains(x, fp)));
      if (!hit.length) throw new RefError(`"${f.flap}" isn't on the paper this fold moves. Point "flap" at the flap you want to fold.`);
      chosen = new Set(hit.flat());
      growTrapped(chosen, comps);
    } else if (f.layers === 'top' && moving.length) {
      const comps = components(moving, ctx.cuts);
      let best: Face[] = [], bestH = -Infinity;
      for (const c of comps) {
        const h = Math.max(...c.map(x => x.maxY()));
        if (h > bestH) { bestH = h; best = c; }
      }
      chosen = new Set(best);
      growTrapped(chosen, comps);
    }
    if (!chosen.size) throw new RefError(`Fold ${k + 1} doesn't move any paper. The fold line misses the sheet; check "${f.bring ?? f.along ?? f.parallel ?? f.line?.join(' to ')}".`);
    if (chosen.size === split.length && k === 0 && folds.length === 1) {
      throw new RefError('This fold moves all of the paper, so the fold line misses the sheet. Check the points, or use "flip" to turn the model over.');
    }

    // Undo splits that didn't end up moving, so untouched layers don't get phantom creases.
    const groups = new Map<Face, Face[]>();
    for (const fc of split) {
      const key = fc.splitFrom ?? fc;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(fc);
    }
    faces = [];
    for (const [parent, parts] of groups) {
      if (parts.length > 1 && !parts.some(p => chosen.has(p))) faces.push(parent);
      else faces.push(...parts);
    }

    let myOps: Op[] = [op];
    if (f.reverse === 'inside') {
      const r = reverseOps(lines[k], id, faces.filter(fc => chosen.has(fc)), faces);
      myOps = r.ops;
      for (const [fc, j] of r.layerOf) fc.ops.add(ops.length + j);
    } else {
      for (const fc of faces) if (chosen.has(fc)) fc.ops.add(ops.length);
    }

    // Record the new crease (the hinge edges of what moved) so later steps can refer to it.
    const segs: [Vec2, Vec2][] = [];
    let tMin = Infinity, tMax = -Infinity;
    for (const fc of chosen) {
      const w = fc.world();
      fc.poly.forEach((p, i) => {
        const j = (i + 1) % fc.poly.length;
        const d0 = w[i].clone().sub(op.pivot).dot(n), d1 = w[j].clone().sub(op.pivot).dot(n);
        if (Math.abs(d0) < EPS * 10 && Math.abs(d1) < EPS * 10 && Math.hypot(p[0] - fc.poly[j][0], p[1] - fc.poly[j][1]) > 1e-6) {
          segs.push([p, fc.poly[j]]);
          for (const v of [w[i], w[j]]) {
            const t = v.clone().sub(op.pivot).dot(op.axis);
            tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
          }
        }
      });
    }
    ctx.creases.set(id, segs);
    if (segs.length) {
      const c: [Vector3, Vector3] = [op.pivot.clone().addScaledVector(op.axis, tMin), op.pivot.clone().addScaledVector(op.axis, tMax)];
      for (const o of myOps) o.crease = o.arrow ? c : null;
      if (!myOps.some(o => o.crease)) myOps[0].crease = c;
    }
    ops.push(...myOps);
  });

  ops.forEach((op, k) => { op.moving = faces.map(fc => fc.ops.has(k)); });
  land(ops.filter(op => op.kind === 'fold'), faces);

  // A reverse fold swings layers down into the pocket; lift the model while it does, so nothing dips into the table.
  const rev = ops.filter(op => op.kind === 'reverse');
  if (rev.length) {
    let reach = 0;
    for (const op of rev) faces.forEach((fc, i) => {
      if (!op.moving[i]) return;
      for (const v of fc.world()) reach = Math.max(reach, v.clone().sub(op.pivot).setY(0).cross(op.axis).length());
    });
    ops.push({
      kind: 'lift', pivot: new Vector3(), axis: UP.clone(), angle: 0, tr: null, lift: UP, prof: linear,
      moving: faces.map(() => true), crease: null, arrow: false, arrowEnd: 1, hop: reach + 0.5,
    });
  }

  return finish(index, spec, 'table', faces, ops);
}

/** Cut slits through every layer. The paper stays where it is; it just stops being joined along each slit. */
function compileCut(spec: StepSpec, index: number, start: Face[], ctx: RefContext): Step {
  let faces = start.map(f => new Face(f.poly, f.M, f.tags));
  const ops: Op[] = [];
  const top = Math.max(...faces.map(f => f.maxY()));
  ctx.cuts ??= [];
  for (const [ra, rb] of spec.cut!.slits) {
    const A = xz(pointOf(resolve(ra, faces, ctx))), B = xz(pointOf(resolve(rb, faces, ctx)));
    const L = A.distanceTo(B);
    if (L < 1e-3) throw new RefError(`The slit from "${ra}" to "${rb}" has no length.`);
    const dir = B.clone().sub(A).normalize(), n = new Vector3(-dir.z, 0, dir.x);
    let made = 0;
    const next: Face[] = [];
    for (const f of faces) {
      const w = f.world();
      const d = w.map(v => v.clone().sub(A).dot(n));
      if (!(d.some(x => x > EPS) && d.some(x => x < -EPS))) { next.push(f); continue; }
      // Where the slit's line crosses this piece.
      const ts: number[] = [];
      for (let i = 0; i < w.length; i++) {
        const j = (i + 1) % w.length;
        if ((d[i] > EPS && d[j] < -EPS) || (d[i] < -EPS && d[j] > EPS)) {
          const p = w[i].clone().lerp(w[j], d[i] / (d[i] - d[j]));
          ts.push(p.clone().sub(A).dot(dir));
        } else if (Math.abs(d[i]) <= EPS) ts.push(w[i].clone().sub(A).dot(dir));
      }
      const t0 = Math.max(0, Math.min(...ts)), t1 = Math.min(L, Math.max(...ts));
      if (t1 - t0 < 1e-4) { next.push(f); continue; }
      // A slit that ends inside a piece: first split across it at the end, so every piece stays convex.
      let parts = [f];
      for (const [t, sgn] of [[t0, -1], [t1, 1]] as const) {
        if (t <= Math.min(...ts) + 1e-4 || t >= Math.max(...ts) - 1e-4) continue;
        const P = A.clone().addScaledVector(dir, t);
        parts = parts.flatMap(p => splitFace(p, P, dir.clone().multiplyScalar(sgn)));
      }
      parts = parts.flatMap(p => {
        const c = p.centroidWorld().sub(A).dot(dir);
        return c > t0 && c < t1 ? splitFace(p, A, n) : [p];
      });
      for (const p of parts) { p.splitFrom = undefined; next.push(p); }
      const inv = f.M.clone().invert();
      const flat = (t: number): Vec2 => { const v = A.clone().addScaledVector(dir, t).setY(w[0].y).applyMatrix4(inv); return [v.x, -v.z]; };
      ctx.cuts.push([flat(t0), flat(t1)]);
      made++;
    }
    if (!made) throw new RefError(`The slit from "${ra}" to "${rb}" doesn't cross any paper.`);
    faces = next;
    const mark: Op = {
      kind: 'cut', pivot: A.clone(), axis: dir.clone(), angle: 0, tr: null, lift: UP, prof: linear,
      moving: [], crease: [A.clone().setY(top), B.clone().setY(top)], arrow: false, arrowEnd: 1,
    };
    ops.push(mark);
  }
  const tab = spec.cut!.tab;
  if (tab) faces = markTab(tab, spec.cut!.slits, faces, ctx);
  ops.forEach(op => { op.moving = faces.map(() => false); });
  return finish(index, spec, 'table', faces, ops);
}

/**
 * The tab between two slits: the paper between them, from the cut edge to the line joining the
 * slits' ends. Tags it `tab:<id>` and records that line as `crease:<id>`, the hinge it bends on.
 */
function markTab(id: string, slits: [string, string][], faces: Face[], ctx: RefContext): Face[] {
  if (slits.length !== 2) throw new RefError('A tab sits between exactly two slits.');
  const [[a1, b1], [a2, b2]] = slits.map(([ra, rb]) => [xz(pointOf(resolve(ra, faces, ctx))), xz(pointOf(resolve(rb, faces, ctx)))]);
  const along = b2.clone().sub(b1), width = along.length();
  if (width < 1e-3) throw new RefError('The two slits end in the same place, so there is no tab between them.');
  along.normalize();
  const n = new Vector3(-along.z, 0, along.x);
  // n points from the hinge toward the cut edge.
  if (a1.clone().add(a2).multiplyScalar(0.5).sub(b1).dot(n) < 0) n.negate();
  const between = (p: Vector3) => { const t = p.clone().sub(b1).dot(along); return t > 1e-4 && t < width - 1e-4; };
  // Make sure the paper between the slits is split along the hinge.
  const out = faces.flatMap(f => (between(f.centroidWorld()) ? splitFace(f, b1, n) : [f]));
  for (const f of out) f.splitFrom = undefined;
  const segs: [Vec2, Vec2][] = [];
  let found = false;
  for (const f of out) {
    const c = f.centroidWorld();
    if (!between(c) || c.clone().sub(b1).dot(n) <= 0) continue;
    // A piece between the slits on the edge side of the hinge: part of the tab, if a slit bounds it.
    f.tags.add(`tab:${id}`);
    found = true;
    const w = f.world();
    f.poly.forEach((p, i) => {
      const j = (i + 1) % f.poly.length;
      if (Math.abs(w[i].clone().sub(b1).dot(n)) < 1e-3 && Math.abs(w[j].clone().sub(b1).dot(n)) < 1e-3) segs.push([p, f.poly[j]]);
    });
  }
  if (!found || !segs.length) throw new RefError(`No paper lies between the two slits, so the tab "${id}" is empty.`);
  ctx.creases.set(id, segs);
  return out;
}

function compileFlip(spec: StepSpec, index: number, start: Face[]): Step {
  const faces = start.map(f => new Face(f.poly, f.M, f.tags));
  const pts = faces.flatMap(f => f.world());
  const minX = Math.min(...pts.map(p => p.x)), maxX = Math.max(...pts.map(p => p.x));
  const minZ = Math.min(...pts.map(p => p.z)), maxZ = Math.max(...pts.map(p => p.z));
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const axis = typeof spec.flip === 'object' && spec.flip.axis === 'short' ? 'short' : 'long';
  const line: Line = axis === 'long'
    ? { a: new Vector3(cx, 0, minZ), b: new Vector3(cx, 0, maxZ), mover: new Vector3(maxX, 0, cz) }
    : { a: new Vector3(minX, 0, cz), b: new Vector3(maxX, 0, cz), mover: new Vector3(cx, 0, maxZ) };
  const { op } = makeOp(line, { kind: 'flip', angle: 180 });
  op.moving = faces.map(() => true);
  // Turning over about the middle would dip one half into the table; lift it while it turns.
  op.hop = axis === 'long' ? (maxX - minX) / 2 : (maxZ - minZ) / 2;
  land([op], faces);
  return finish(index, spec, 'table', faces, [op]);
}

function compilePose(spec: StepSpec, index: number, start: Face[], ctx: RefContext, W: number, H: number, plane: CompiledPlane): Step {
  const pose = spec.pose as PoseSpec;
  const faces = start.map(f => new Face(f.poly, f.M, f.tags));
  const spine = resolve(pose.spine, faces, ctx), keel = resolve(pose.keel, faces, ctx);
  if (spine.kind !== 'line' || keel.kind !== 'line') throw new RefError('"spine" and "keel" must be lines.');
  const wingOf = (f: Face) => pose.wings.find(id => f.tags.has(`moved:${id}`));
  for (const id of pose.wings) {
    if (!faces.some(f => f.tags.has(`moved:${id}`))) throw new RefError(`No paper was moved by a fold with id "${id}".`);
  }
  let lo = Infinity, hi = -Infinity;
  faces.forEach(f => { if (!wingOf(f)) f.world().forEach(v => { lo = Math.min(lo, v.y); hi = Math.max(hi, v.y); }); });
  const mid = (lo + hi) / 2;

  // keel side: the end of the keel farthest from the spine
  const sA = xz(spine.a), sB = xz(spine.b), sDir = sB.clone().sub(sA).normalize();
  const distToSpine = (p: Vector3) => { const q = xz(p).sub(sA); return q.sub(sDir.clone().multiplyScalar(q.dot(sDir))).length(); };
  const keelFar = distToSpine(keel.a) > distToSpine(keel.b) ? keel.a : keel.b;
  // nose: the spine end that touches the keel
  const kA = xz(keel.a), kDir = xz(keel.b).sub(kA).normalize();
  const distToKeel = (p: Vector3) => { const q = xz(p).sub(kA); return q.sub(kDir.clone().multiplyScalar(q.dot(kDir))).length(); };
  let noseFirst = distToKeel(spine.a) < distToKeel(spine.b);
  if (pose.nose) {
    const N = pointOf(resolve(pose.nose, faces, ctx));
    noseFirst = distXZ(spine.a, N) < distXZ(spine.b, N);
  } else if (Math.abs(distToKeel(spine.a) - distToKeel(spine.b)) < 0.5) {
    throw new RefError('The wings hinge parallel to the keel, so I can\'t tell which end is the nose. Add "nose" to the pose: a point at the front of the plane.');
  }
  const [nose, tail] = noseFirst ? [spine.a, spine.b] : [spine.b, spine.a];
  const line: Line = { a: spine.a, b: spine.b, mover: keelFar };

  // Once the body stands, folded wings can hang further below the spine than the body itself.
  // Float high enough to clear the table, and lift before turning so nothing sweeps through it.
  let reach = 0;
  faces.forEach(f => f.world().forEach(v => { reach = Math.max(reach, distToSpine(v)); }));
  plane.flyHeight = Math.max(plane.flyHeight, reach + 1.5);
  const flyH = plane.flyHeight;
  const wingProf = range(0.5, 1), standProf = range(0.2, 0.62), liftProf = range(0, 0.4);
  const ops: Op[] = [];
  // Fins open first, in the table frame, so the wing turns carry them along.
  for (const id of pose.fins ?? []) {
    const mine = faces.map(f => f.tags.has(`moved:${id}`));
    if (!mine.some(Boolean)) throw new RefError(`No paper was moved by a fold with id "${id}", so there's no fin to open.`);
    const L = resolve(`crease:${id}`, faces, ctx);
    if (L.kind !== 'line') throw new RefError(`"crease:${id}" isn't a line.`);
    const fin = faces.filter((_, i) => mine[i]);
    const nb = faces.filter((f, i) => !mine[i] && fin.some(g => sharedSegments(f, g, ctx.cuts).length));
    const avgY = (fs: Face[]) => fs.reduce((s, f) => s + f.centroidWorld().y, 0) / Math.max(1, fs.length);
    const finY = avgY(fin), nbY = nb.length ? avgY(nb) : finY - 1;
    const c = new Vector3();
    fin.forEach(f => c.add(f.centroidWorld()));
    c.multiplyScalar(1 / fin.length);
    const { op } = makeOp({ a: L.a, b: L.b, mover: c }, {
      kind: 'pose', angle: pose.finAngle ?? 90, prof: range(0.6, 1), h: (finY + nbY) / 2, lift: finY > nbY ? UP : DOWN,
    });
    op.moving = mine;
    ops.push(op);
  }
  // Tabs (elevators) bend first too, each wing's tab on its own hinge. Which way is "up" depends on
  // how that wing opens, so the direction is settled once every op is known (below).
  const tabOps: Op[] = [];
  for (const t of pose.tabs ?? []) {
    const L = resolve(`crease:${t.id}`, faces, ctx);
    if (L.kind !== 'line') throw new RefError(`"crease:${t.id}" isn't a line.`);
    const groups = new Map<string, number[]>();
    faces.forEach((f, i) => {
      if (!f.tags.has(`tab:${t.id}`)) return;
      const key = wingOf(f) ?? 'body';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(i);
    });
    if (!groups.size) throw new RefError(`No paper belongs to the tab "${t.id}".`);
    for (const idx of groups.values()) {
      const c = new Vector3();
      idx.forEach(i => c.add(faces[i].centroidWorld()));
      c.multiplyScalar(1 / idx.length);
      const { op } = makeOp({ a: L.a, b: L.b, mover: c }, { kind: 'pose', angle: t.angle ?? 20, prof: range(0.6, 1), h: c.y, lift: UP });
      const set = new Set(idx);
      op.moving = faces.map((_, i) => set.has(i));
      ops.push(op);
      tabOps.push(op);
    }
  }
  for (const id of pose.wings) {
    const mine = faces.map(f => wingOf(f) === id);
    const ys = faces.filter((_, i) => mine[i]).flatMap(f => f.world().map(v => v.y));
    const above = ys.reduce((s, y) => s + y, 0) / ys.length > mid;
    const { op } = makeOp(line, {
      kind: 'pose', angle: 90 + (pose.dihedral ?? 6), prof: wingProf,
      h: above ? hi : lo, lift: above ? UP : DOWN,
    });
    op.moving = mine;
    ops.push(op);
  }
  const stand = makeOp(line, { kind: 'pose', angle: 90, prof: standProf, h: mid, lift: DOWN }).op;
  stand.moving = faces.map(() => true);
  ops.push(stand);

  const n = new Vector3(nose.x, mid, nose.z), t = new Vector3(tail.x, mid, tail.z);
  const center = n.clone().add(t).multiplyScalar(0.5);
  const dir = n.clone().sub(t).normalize(), want = new Vector3(0, 0, -1);
  const yawAxis = new Vector3().crossVectors(dir, want);
  ops.push({
    kind: 'pose', pivot: center, axis: yawAxis.lengthSq() > 1e-9 ? yawAxis.normalize() : UP.clone(),
    angle: dir.angleTo(want), tr: new Vector3(W / 2, flyH, -H / 2).sub(center), lift: UP, prof: liftProf,
    moving: faces.map(() => true), crease: null, arrow: false, arrowEnd: 1,
  });
  // Bend each tab toward the top of the plane in flight: try both ways and keep the higher one.
  for (const op of tabOps) {
    const i = op.moving.indexOf(true);
    const yAt = () => {
      const M = faces[i].M.clone();
      ops.forEach(o => { if (o.moving[i]) M.premultiply(opMatrix(o, 1)); });
      return faces[i].centroidWorld().applyMatrix4(faces[i].M.clone().invert()).applyMatrix4(M).y;
    };
    const up = yAt();
    op.angle = -op.angle;
    if (yAt() < up) op.angle = -op.angle;
  }
  return finish(index, spec, 'flight', faces, ops);
}

/* ---------- entry point ---------- */

/**
 * Compile as far as the recipe works. Each step is checked against the physical rules as soon as
 * it's built, so a later step never builds on a broken one. Returns the steps that worked and,
 * if it stopped early, why.
 */
export function compilePlaneSoFar(spec: PlaneSpec): { plane: CompiledPlane; error?: PlaneError } {
  const steps: Step[] = [];
  const problems = validatePlane(spec);
  const first = problems[0];
  // A problem in step N still lets steps before N fold, so a broken recipe can be reviewed up to the break.
  const stopAt = first ? (first.step ?? 0) : spec.steps.length;
  const { W, H } = first?.step == null && first ? { W: 21, H: 29.7 } : paperSize(spec.paper);
  const plane: CompiledPlane = {
    spec, width: W, height: H, creases: [], flyHeight: H / 3, steps, cuts: [],
    done: spec.done ?? { title: 'Ready to fly', text: 'Hold it just behind the nose and throw gently, straight ahead.' },
  };
  const ctx: RefContext = { W, H, creases: new Map(), cuts: plane.cuts };
  let faces = [new Face([[0, 0], [W, 0], [W, H], [0, H]])];
  for (let i = 0; i < stopAt; i++) {
    const s = spec.steps[i];
    const known = new Set(ctx.creases.keys());
    try {
      const st = s.pose ? compilePose(s, i, faces, ctx, W, H, plane)
        : s.flip ? compileFlip(s, i, faces)
        : s.cut ? compileCut(s, i, faces, ctx)
        : compileFolds(s, i, faces, ctx);
      // Physical checks: refuse anything a real sheet of paper couldn't do.
      const issues = auditStep(plane, st);
      if (issues.length) throw new PlaneError(i, issues[0].message, issues);
      if (st.view === 'table') settle(st);
      steps.push(st);
      const named = new Set([...(s.folds ?? (s.fold ? [s.fold] : [])).map(f => f.id), s.cut?.tab].filter(Boolean));
      for (const [id, segs] of ctx.creases) if (!known.has(id)) plane.creases.push({ id, step: i, named: named.has(id), segs });
      faces = st.end;
    } catch (e) {
      return { plane, error: e instanceof PlaneError ? e : new PlaneError(i, (e as Error).message) };
    }
  }
  return first ? { plane, error: new PlaneError(first.step, first.message) } : { plane };
}

/** Compile a plane recipe into steps the renderer can scrub through. Throws PlaneError with the step number on problems. */
export function compilePlane(spec: PlaneSpec): CompiledPlane {
  const { plane, error } = compilePlaneSoFar(spec);
  if (error) throw error;
  return plane;
}

/** A fold arrow for op k: a path in the table frame, floating just above the paper. */
export function arrowPath(step: Step, k: number, samples = 40): Vector3[] | null {
  const op = step.ops[k];
  if (!op.arrow) return null;
  const sDir = new Vector3().crossVectors(op.lift, op.axis).normalize();
  let best: { d: number; q: Vector3 } | null = null, axialSum = 0, axialN = 0;
  step.faces.forEach((f, i) => {
    if (!op.moving[i]) return;
    for (const w of f.world()) {
      const rel = w.sub(op.pivot);
      const ax = rel.dot(op.axis);
      axialSum += ax; axialN++;
      const q = rel.addScaledVector(op.axis, -ax);
      if (q.dot(sDir) <= 0) continue;
      const d = q.length();
      if (!best || d > best.d) best = { d, q: q.clone() };
    }
  });
  if (!best) return null;
  const b = best as { d: number; q: Vector3 };
  const pt = op.pivot.clone().addScaledVector(op.axis, axialSum / axialN).addScaledVector(b.q, 0.68);
  pt.y = op.pivot.y;
  const top = Math.max(...step.faces.map(f => f.maxY())) + 0.55;
  const out: Vector3[] = [];
  for (let s = 0; s <= samples; s++) {
    const p = pt.clone().applyMatrix4(opMatrix(op, op.prof((s / samples) * op.arrowEnd)));
    p.y += top;
    out.push(p);
  }
  return out;
}

export { flatToLocal };
