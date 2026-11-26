import { Vector3 } from 'three';
import { EPS, Face, flatContains, flatToLocal, overlapsFromAbove, sharedSegments, splitFace } from './geometry';
import { RefError, flatPoint, resolve, type RefContext } from './refs';
import type { FoldSpec, StepSpec, Vec2 } from './types';
import { GAP, finish, linear, makeOp, range, xz, type Op, type Profile, type Step } from './compile';

const UP = new Vector3(0, 1, 0);
const DOWN = new Vector3(0, -1, 0);
const fmt = (p: Vector3) => `(${p.x.toFixed(1)}, ${(-p.z).toFixed(1)}) cm on the table`;

/** Reflect a direction in the table plane across a line with unit direction d. */
const mirror = (v: Vector3, d: Vector3) => {
  const k = 2 * (v.x * d.x + v.z * d.z);
  return new Vector3(k * d.x - v.x, 0, k * d.z - v.z);
};
/** Up and back down again, peaking halfway. */
const standAndReturn: Profile = t => (t < 0.5 ? t / 0.5 : Math.max(0, (1 - t) / 0.5));

/**
 * Squash fold. A flap of two layers joined along a fold (its spine) is hinged on a line. It stands
 * up, opens, and is pressed flat so the spine lands on a new line through the point where it meets
 * the hinge.
 *
 * Flat, the result is two reflections per layer. The lower layer keeps its place near the hinge and
 * folds its outer part (the part holding the spine) across the line halfway between the spine and
 * its landing line. The upper layer turns over the hinge to the other side, and its outer part folds
 * across the line halfway between the spine and the landing line mirrored in the hinge. Both outer
 * parts carry the spine onto the landing line, so the two layers stay joined along it.
 *
 * In motion: the flap stands up (the upper layer turns to 90° about the hinge, the lower one to 80°), then the lower layer lies
 * back down while the upper layer carries on over, and both outer parts fold into the opening pocket.
 * The outer parts end up on top of their inner parts, inside surfaces together, as real paper does.
 */
export function compileSquash(spec: StepSpec, index: number, start: Face[], ctx: RefContext, f: FoldSpec): Step {
  const id = f.id ?? `s${index + 1}`;
  if (f.unfold) throw new RefError('A squash fold can\'t be unfolded in the same step.');
  if (f.reverse) throw new RefError('A fold is either a squash or a reverse fold, not both.');
  if (!f.to) throw new RefError('A squash fold also needs "to": the line or point its folded edge lands on.');

  const faces = start.map(fc => new Face(fc.poly, fc.M, fc.tags));
  const H = resolve(f.squash!, faces, ctx);
  if (H.kind !== 'line') throw new RefError(`"squash" needs the line the flap is hinged on (edge:… or crease:…), got "${f.squash}".`);
  const ha = xz(H.a), hd = xz(H.b).sub(ha);
  if (hd.length() < 1e-3) throw new RefError(`"${f.squash}" has folded down to a point here, so it isn't a hinge.`);
  hd.normalize();
  const hn = new Vector3(-hd.z, 0, hd.x);
  const offHinge = (p: Vector3) => xz(p).sub(ha).dot(hn);
  const onHinge = (fc: Face, seg: [Vec2, Vec2]) => seg.every(p => Math.abs(offHinge(flatToLocal(p).applyMatrix4(fc.M))) < 1e-3);

  // 1. The flap: the paper joined to the chosen piece, except across the hinge.
  let seed: Face | undefined;
  if (f.flap) {
    const fp = flatPoint(f.flap, ctx);
    seed = faces.filter(x => flatContains(x, fp)).sort((a, b) => b.maxY() - a.maxY())[0];
    if (!seed) throw new RefError(`"${f.flap}" isn't on the paper.`);
  } else {
    const hinged = faces.filter(x => {
      const w = x.world();
      return w.some((v, i) => {
        const u = w[(i + 1) % w.length];
        return Math.abs(offHinge(v)) < 1e-3 && Math.abs(offHinge(u)) < 1e-3 && v.distanceTo(u) > 1e-3;
      }) && w.some(v => Math.abs(offHinge(v)) > 1e-3);
    });
    seed = hinged.sort((a, b) => b.maxY() - a.maxY())[0];
    if (!seed) throw new RefError(`No flap is hinged on "${f.squash}".`);
  }
  const side = Math.sign(offHinge(seed.centroidWorld()));
  if (!side) throw new RefError(`The flap sits on the hinge "${f.squash}" itself. Point "flap" at the flap you want to squash.`);
  const flap = new Set<Face>([seed]);
  for (const stack = [seed]; stack.length; ) {
    const g = stack.pop()!;
    for (const h of faces) {
      if (flap.has(h)) continue;
      const segs = sharedSegments(g, h, ctx.cuts);
      if (!segs.some(sg => !onHinge(g, sg))) continue;
      if (h.world().some(v => offHinge(v) * side < -1e-3)) {
        throw new RefError(`The flap isn't free to stand up on "${f.squash}": it's joined to paper on the other side of the hinge near ${fmt(h.centroidWorld())}.`);
      }
      flap.add(h);
      stack.push(h);
    }
  }
  const fl = [...flap];
  for (const st of faces) {
    if (flap.has(st)) continue;
    for (const x of fl) {
      if (st.maxY() > x.maxY() + GAP / 2 && overlapsFromAbove(x, st)) {
        throw new RefError(`Only a flap on top can be squashed. Paper near ${fmt(st.centroidWorld())} lies on top of this one.`);
      }
    }
  }

  // 2. Its two sides, which face opposite ways because they're joined by a fold. The lower side stays.
  const up = (x: Face) => {
    const w = x.world();
    return new Vector3().crossVectors(w[1].clone().sub(w[0]), w[2].clone().sub(w[0])).y > 0;
  };
  const g1 = fl.filter(up), g2 = fl.filter(x => !up(x));
  const mean = (g: Face[]) => g.reduce((s, x) => s + x.maxY(), 0) / Math.max(1, g.length);
  if (!g1.length || !g2.length) {
    throw new RefError('A squash fold needs a flap of two layers joined along a fold. This flap is a single layer.');
  }
  const [A, B] = mean(g1) < mean(g2) ? [g1, g2] : [g2, g1];
  for (const a of A) for (const b of B) {
    if (overlapsFromAbove(a, b) && a.maxY() > b.maxY()) {
      throw new RefError('A squash fold needs a flap of exactly two layers joined along a fold. This flap has more layers; fold the extra ones out of the way first.');
    }
  }

  // 3. The spine: where the two sides are joined. It must run into the hinge.
  const spinePts: Vector3[] = [];
  for (const a of A) for (const b of B) for (const sg of sharedSegments(a, b, ctx.cuts)) {
    for (const p of sg) spinePts.push(xz(flatToLocal(p).applyMatrix4(a.M)));
  }
  if (!spinePts.length) throw new RefError('A squash fold needs a flap of two layers joined along a fold. These layers aren\'t joined.');
  let s0 = spinePts[0], s1 = spinePts[0];
  for (const p of spinePts) for (const q of spinePts) if (p.distanceTo(q) > s0.distanceTo(s1)) { s0 = p; s1 = q; }
  const sd = s1.clone().sub(s0);
  if (sd.length() < 1e-3) throw new RefError('The flap\'s two layers only touch at a point, so it has no folded edge to squash.');
  sd.normalize();
  const offSpine = (p: Vector3) => Math.abs(p.clone().sub(s0).dot(new Vector3(-sd.z, 0, sd.x)));
  if (spinePts.some(p => offSpine(p) > 1e-3)) throw new RefError('The flap\'s two layers are joined along more than one line, so it can\'t open as one pocket.');
  const cross = sd.x * hd.z - sd.z * hd.x;
  if (Math.abs(cross) < 1e-6) throw new RefError(`The flap's folded edge runs along "${f.squash}", so there's no point for it to turn on.`);
  const w0 = s0.clone().sub(ha);
  const P = s0.clone().addScaledVector(sd, (hd.x * w0.z - hd.z * w0.x) / cross);
  const near = spinePts.reduce((m, p) => Math.min(m, p.distanceTo(P)), Infinity);
  if (near > 0.05) throw new RefError(`The flap's folded edge has to run into the hinge "${f.squash}"; it stops ${near.toFixed(1)} cm short.`);
  const far = spinePts.reduce((m, p) => (p.distanceTo(P) > m.distanceTo(P) ? p : m), spinePts[0]);
  const s = far.clone().sub(P).normalize();

  // 4. Where the spine lands: a ray from P.
  const T = resolve(f.to, faces, ctx);
  let t: Vector3;
  if (T.kind === 'point') {
    t = xz(T.p).sub(P);
    if (t.length() < 1e-3) throw new RefError(`"${f.to}" is where the folded edge meets the hinge. Point "to" somewhere along where the edge should land.`);
  } else {
    const ta = xz(T.a), tb = xz(T.b), td = tb.clone().sub(ta);
    if (td.length() < 1e-3) throw new RefError(`"${f.to}" has folded down to a point here, so it isn't a line to land on.`);
    td.normalize();
    const miss = Math.abs(P.clone().sub(ta).dot(new Vector3(-td.z, 0, td.x)));
    if (miss > 0.05) {
      throw new RefError(`The folded edge turns on ${fmt(P)}, so it can only land on a line through that point. "${f.to}" misses it by ${miss.toFixed(1)} cm; point "to" at a point instead.`);
    }
    t = (ta.distanceTo(P) > tb.distanceTo(P) ? ta : tb).clone().sub(P);
  }
  t.normalize();
  if (s.dot(t) > Math.cos(0.5 * Math.PI / 180)) throw new RefError(`The flap's folded edge already lies along "${f.to}", so there's nothing to squash.`);
  if (t.dot(hn) * side < -1e-6 && Math.abs(t.dot(hn)) > 1e-3) {
    // Landing on the far side of the hinge would need the lower layer to pass through the upper one.
    throw new RefError(`"${f.to}" is on the other side of the hinge from the flap. A squashed flap spreads over its own side and along the hinge.`);
  }
  const cA = s.clone().add(t), cB = s.clone().add(mirror(t, hd));
  if (cA.length() < 1e-6 || cB.length() < 1e-6) throw new RefError(`The folded edge can't land on "${f.to}" with a squash fold.`);
  cA.normalize(); cB.normalize();

  // 5. Split each layer along its new crease. The outer part holds the spine.
  const sideOf = (c: Vector3) => {
    const n = new Vector3(-c.z, 0, c.x);
    return { n, outer: Math.sign(s.dot(n)) };
  };
  const sa = sideOf(cA), sb = sideOf(cB);
  const top = Math.max(...faces.map(x => x.maxY()));
  const heights = (g: Face[]) => ({ lo: Math.min(...g.map(x => x.maxY())), hi: Math.max(...g.map(x => x.maxY())) });
  const hA = heights(A), hB = heights(B);
  const splitAll = (g: Face[], n: Vector3) => g.flatMap(x => splitFace(x, P, n)).map(x => { x.splitFrom = undefined; return x; });
  const A2 = splitAll(A, sa.n), B2 = splitAll(B, sb.n);
  const isOuter = (x: Face, sd2: { n: Vector3; outer: number }) => Math.sign(xz(x.centroidWorld()).sub(P).dot(sd2.n)) === sd2.outer;
  const aOut = new Set(A2.filter(x => isOuter(x, sa))), bOut = new Set(B2.filter(x => isOuter(x, sb)));
  if (!aOut.size || aOut.size === A2.length) throw new RefError('The new crease in the lower layer misses it. Check where the folded edge lands.');
  if (!bOut.size || bOut.size === B2.length) throw new RefError('The new crease in the upper layer misses it. Check where the folded edge lands.');
  const allA = new Set(A2), allB = new Set(B2);
  const out = [...faces.filter(x => !flap.has(x)), ...A2, ...B2];

  // 6. Moves. Inner-frame moves come first: the outer parts fold, then each whole layer turns on the hinge.
  // Final heights, bottom to top: the upper layer's inner part, the lower layer's outer part, the upper layer's outer part.
  const binBase = top + GAP;
  const aoutBase = binBase + (hB.hi - hB.lo) + GAP;
  const boutBase = aoutBase + (hA.hi - hA.lo) + GAP;
  const mid = (g: Set<Face>) => { const c = new Vector3(); g.forEach(x => c.add(x.centroidWorld())); return c.multiplyScalar(1 / g.size); };
  const hingeLine = (mover: Vector3) => ({ a: ha, b: ha.clone().add(hd), mover });
  const along = (c: Vector3, mover: Vector3) => ({ a: P, b: P.clone().add(c), mover });

  const aFold = makeOp(along(cA, far), { kind: 'squash', id, angle: 180, prof: range(0.5, 1), h: hA.hi, lift: UP }).op;
  aFold.tr = new Vector3(0, aoutBase - hA.hi, 0);
  const bFold = makeOp(along(cB, far), { kind: 'squash', id, angle: 180, prof: range(0.5, 1), h: hB.lo, lift: DOWN }).op;
  const tr1 = binBase - hB.hi;
  bFold.tr = new Vector3(0, 2 * hB.hi - hB.lo + tr1 - boutBase, 0);
  // The lower layer stops short of upright, so the two layers never share a plane (they'd flicker).
  const aStand = makeOp(hingeLine(mid(allA)), { kind: 'squash', id, angle: 80, prof: standAndReturn, h: hA.lo, lift: UP }).op;
  const bTurn = makeOp(hingeLine(mid(allB)), { kind: 'squash', id, angle: 180, prof: linear, h: hB.hi, lift: UP }).op;
  bTurn.tr = new Vector3(0, tr1, 0);

  const ops: Op[] = [aFold, bFold, aStand, bTurn];
  const sets = [aOut, bOut, allA, allB];
  ops.forEach((op, k) => {
    op.group = id;
    op.arrow = op === bTurn;
    op.arrowEnd = 1;
    op.moving = out.map(x => sets[k].has(x));
  });

  // 7. The new creases, so later steps can point at them, drawn where they are at the start.
  const record = (g: Set<Face>, c: Vector3, n: Vector3, name: string, op: Op) => {
    const segs: [Vec2, Vec2][] = [];
    let tMax = 0;
    for (const x of g) {
      const w = x.world();
      x.poly.forEach((p, i) => {
        const j = (i + 1) % x.poly.length;
        const d0 = xz(w[i]).sub(P).dot(n), d1 = xz(w[j]).sub(P).dot(n);
        if (Math.abs(d0) < EPS * 10 && Math.abs(d1) < EPS * 10 && Math.hypot(p[0] - x.poly[j][0], p[1] - x.poly[j][1]) > 1e-6) {
          segs.push([p, x.poly[j]]);
          tMax = Math.max(tMax, xz(w[i]).sub(P).dot(c), xz(w[j]).sub(P).dot(c));
        }
      });
    }
    ctx.creases.set(name, segs);
    const y = Math.max(...out.map(x => x.maxY()));
    op.crease = [P.clone().setY(y), P.clone().addScaledVector(c, tMax).setY(y)];
  };
  record(aOut, cA, sa.n, id, aFold);
  record(bOut, cB, sb.n, `${id}-2`, bFold);

  return finish(index, spec, 'table', out, ops);
}
