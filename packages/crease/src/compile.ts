import { Matrix4, Vector3 } from 'three';
import { EPS, Face, components, flatToLocal, splitFace } from './geometry';
import { RefError, resolve, type RefContext, type Resolved } from './refs';
import type { FoldSpec, PaperSpec, PlaneSpec, PoseSpec, StepSpec, Vec2 } from './types';
import { validatePlane } from './validate';

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

/** One rigid motion inside a step: rotate some faces about an axis, optionally translate. */
export interface Op {
  kind: 'fold' | 'flip' | 'pose';
  id?: string;
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

export interface CompiledPlane {
  spec: PlaneSpec;
  width: number;
  height: number;
  /** How high the finished plane floats above the table in the flight pose (cm). */
  flyHeight: number;
  steps: Step[];
  done: { title: string; text: string };
}

export class PlaneError extends Error {
  constructor(public step: number | null, message: string) {
    super(step == null ? message : `Step ${step + 1}: ${message}`);
  }
}

export function paperSize(p: PaperSpec): { W: number; H: number } {
  if (p === 'A4') return { W: 21, H: 29.7 };
  if (p === 'Letter') return { W: 21.59, H: 27.94 };
  return { W: p.width, H: p.height };
}

/* ---------- motion ---------- */

export function opMatrix(op: Op, f: number): Matrix4 {
  const tr = op.tr ? op.tr.clone().multiplyScalar(f) : new Vector3();
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
  const side = Math.sign(r.clone().sub(pa).dot(n));
  if (side === 0) throw new RefError('The side that moves is on the fold line itself.');
  const s = r.clone().sub(pa);
  s.addScaledVector(axis, -s.dot(axis));
  if (new Vector3().crossVectors(axis, s).dot(lift) < 0) axis.negate();
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
  if (f.along) {
    const L = resolve(f.along, faces, ctx);
    if (L.kind !== 'line') throw new RefError(`"along" needs a line (edge:… or crease:…), got "${f.along}".`);
    if (!f.move) throw new RefError('A fold "along" a line also needs "move": a point on the side that moves.');
    return { a: L.a, b: L.b, mover: pointOf(resolve(f.move, faces, ctx)) };
  }
  if (!f.bring || !f.to) throw new RefError('A fold needs "bring" and "to", or "along" and "move".');
  const A = resolve(f.bring, faces, ctx), B = resolve(f.to, faces, ctx);

  const bisector = (p: Vector3, q: Vector3): Line => {
    const mid = xz(p).add(xz(q)).multiplyScalar(0.5);
    const d = xz(q).sub(xz(p));
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

/** Lift folded faces so they land just above everything they cover. */
function land(ops: Op[], faces: Face[]) {
  for (const op of ops) {
    if (op.angle < 170 * DEG || op.kind === 'pose') continue;
    let mov = -Infinity, stat = -Infinity;
    faces.forEach((f, i) => {
      const h = Math.max(...f.world().map(v => v.dot(op.lift)));
      if (op.moving[i]) mov = Math.max(mov, h); else stat = Math.max(stat, h);
    });
    op.tr = op.lift.clone().multiplyScalar(mov + (stat > -Infinity ? stat + GAP : 0));
  }
}

function finish(index: number, spec: StepSpec, view: Step['view'], faces: Face[], ops: Op[]): Step {
  const step: Step = {
    index, title: spec.title, text: spec.text ?? '', view, faces, ops,
    movingAny: faces.map((_, i) => ops.some(op => op.moving[i])),
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

/* ---------- step kinds ---------- */

function compileFolds(spec: StepSpec, index: number, start: Face[], ctx: RefContext): Step {
  const folds = spec.folds ?? [spec.fold!];
  const lines = folds.map(f => solveFold(f, start, ctx));
  let faces = start.map(f => new Face(f.poly, f.M, f.tags));
  const ops: Op[] = [];

  folds.forEach((f, k) => {
    const id = f.id ?? (folds.length > 1 ? `s${index + 1}-${k + 1}` : `s${index + 1}`);
    const { op, n, onSide } = makeOp(lines[k], {
      kind: 'fold', id, angle: f.unfold ? 175 : 180, prof: f.unfold ? thereAndBack : linear,
    });
    faces.forEach(fc => { fc.splitFrom = undefined; });
    const split = faces.flatMap(fc => splitFace(fc, op.pivot, n));
    const moving = split.filter(onSide);
    let chosen = new Set(moving);
    if (f.layers === 'top' && moving.length) {
      let best: Face[] = [], bestH = -Infinity;
      for (const c of components(moving)) {
        const h = Math.max(...c.map(x => x.maxY()));
        if (h > bestH) { bestH = h; best = c; }
      }
      chosen = new Set(best);
    }
    if (!chosen.size) throw new RefError(`Fold ${k + 1} doesn't move any paper.`);

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
    for (const fc of faces) if (chosen.has(fc)) fc.ops.add(k);

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
      op.crease = [op.pivot.clone().addScaledVector(op.axis, tMin), op.pivot.clone().addScaledVector(op.axis, tMax)];
    }
    ops.push(op);
  });

  ops.forEach((op, k) => { op.moving = faces.map(fc => fc.ops.has(k)); });
  land(ops, faces);
  return finish(index, spec, 'table', faces, ops);
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
  land([op], faces);
  return finish(index, spec, 'table', faces, [op]);
}

function compilePose(spec: StepSpec, index: number, start: Face[], ctx: RefContext, W: number, H: number, flyH: number): Step {
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
  const [nose, tail] = distToKeel(spine.a) < distToKeel(spine.b) ? [spine.a, spine.b] : [spine.b, spine.a];
  const line: Line = { a: spine.a, b: spine.b, mover: keelFar };

  const wingProf = range(0.45, 1), bodyProf = range(0, 0.62);
  const ops: Op[] = [];
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
  const stand = makeOp(line, { kind: 'pose', angle: 90, prof: bodyProf, h: mid, lift: DOWN }).op;
  stand.moving = faces.map(() => true);
  ops.push(stand);

  const n = new Vector3(nose.x, mid, nose.z), t = new Vector3(tail.x, mid, tail.z);
  const center = n.clone().add(t).multiplyScalar(0.5);
  const dir = n.clone().sub(t).normalize(), want = new Vector3(0, 0, -1);
  const yawAxis = new Vector3().crossVectors(dir, want);
  ops.push({
    kind: 'pose', pivot: center, axis: yawAxis.lengthSq() > 1e-9 ? yawAxis.normalize() : UP.clone(),
    angle: dir.angleTo(want), tr: new Vector3(W / 2, flyH, -H / 2).sub(center), lift: UP, prof: bodyProf,
    moving: faces.map(() => true), crease: null, arrow: false, arrowEnd: 1,
  });
  return finish(index, spec, 'flight', faces, ops);
}

/* ---------- entry point ---------- */

/** Compile a plane recipe into steps the renderer can scrub through. Throws PlaneError with the step number on problems. */
export function compilePlane(spec: PlaneSpec): CompiledPlane {
  const problems = validatePlane(spec);
  if (problems.length) throw new PlaneError(problems[0].step, problems[0].message);
  const { W, H } = paperSize(spec.paper);
  const flyHeight = H / 3;
  const ctx: RefContext = { W, H, creases: new Map() };
  let faces = [new Face([[0, 0], [W, 0], [W, H], [0, H]])];
  const steps: Step[] = [];
  spec.steps.forEach((s, i) => {
    try {
      const st = s.pose ? compilePose(s, i, faces, ctx, W, H, flyHeight)
        : s.flip ? compileFlip(s, i, faces)
        : compileFolds(s, i, faces, ctx);
      steps.push(st);
      faces = st.end;
    } catch (e) {
      if (e instanceof PlaneError) throw e;
      throw new PlaneError(i, (e as Error).message);
    }
  });
  return {
    spec, width: W, height: H, flyHeight, steps,
    done: spec.done ?? { title: 'Ready to fly', text: 'Hold it just behind the nose and throw gently, straight ahead.' },
  };
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
