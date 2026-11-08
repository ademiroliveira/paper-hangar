import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import Ajv2020 from 'ajv/dist/2020';
import schema from '../plane.schema.json';
import dart from '../../../planes/classic-dart.plane.json';
import { compilePlane, faceMatrix, stepMatrices, validatePlane, arrowPath, projectFinal, type PlaneSpec, type Step } from '../src';

const spec = dart as PlaneSpec;
const W = 21, H = 29.7, C = W / 2;
const DEG = Math.PI / 180;
const V_L3 = H - C / Math.tan(22.5 * DEG);
const U_TAIL = C + H * Math.tan(11.25 * DEG);

/** Distance from a table-frame point to an op's axis line (in the table plane). */
function distToAxis(step: Step, k: number, p: Vector3) {
  const op = step.ops[k];
  const rel = p.clone().sub(op.pivot);
  rel.y = 0;
  const ax = new Vector3(op.axis.x, 0, op.axis.z).normalize();
  return rel.sub(ax.multiplyScalar(rel.dot(ax))).length();
}
const P = (u: number, v: number) => new Vector3(u, 0, -v);

describe('classic dart recipe', () => {
  const plane = compilePlane(spec);

  it('matches the JSON schema', () => {
    const ajv = new Ajv2020({ allErrors: true });
    const ok = ajv.validate(schema, dart);
    expect(ajv.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
  });

  it('compiles all eight steps', () => {
    expect(plane.steps).toHaveLength(8);
    expect(plane.steps.map(s => s.view)).toEqual(['table', 'table', 'table', 'table', 'table', 'table', 'table', 'flight']);
  });

  it('keeps the sheet whole: faces always tile the full sheet', () => {
    for (const st of plane.steps) {
      const area = st.faces.reduce((s, f) => s + f.area(), 0);
      expect(area).toBeCloseTo(W * H, 6);
      for (const f of st.faces) expect(f.area()).toBeGreaterThan(1e-6);
    }
  });

  it('solves the corner folds from "bring corner to center crease through the top middle"', () => {
    const st = plane.steps[1];
    expect(distToAxis(st, 0, P(C, H))).toBeLessThan(1e-6);
    expect(distToAxis(st, 0, P(0, H - C))).toBeLessThan(1e-6);
    expect(distToAxis(st, 1, P(W, H - C))).toBeLessThan(1e-6);
  });

  it('solves the second folds as the bisector of slanted edge and center crease', () => {
    const st = plane.steps[2];
    expect(distToAxis(st, 0, P(C, H))).toBeLessThan(1e-6);
    expect(distToAxis(st, 0, P(0, V_L3))).toBeLessThan(1e-6);
    expect(distToAxis(st, 1, P(W, V_L3))).toBeLessThan(1e-6);
  });

  /** Wing folds must take every layer of the top half on the far side of the crease, and nothing else. */
  function checkWing(si: number, half: 'left' | 'right') {
    const st = plane.steps[si], op = st.ops[0];
    const n = new Vector3().crossVectors(op.axis, op.lift).normalize();
    const movedIdx = op.moving.findIndex(Boolean);
    expect(movedIdx).toBeGreaterThanOrEqual(0);
    const far = Math.sign(st.faces[movedIdx].centroidWorld().sub(op.pivot).dot(n));
    st.faces.forEach((f, i) => {
      const onFar = Math.sign(f.centroidWorld().sub(op.pivot).dot(n)) === far;
      const inHalf = half === 'left' ? f.centroidFlat()[0] < C : f.centroidFlat()[0] > C;
      expect(op.moving[i], `face ${i} (flat centroid ${f.centroidFlat().map(x => x.toFixed(1))})`).toBe(onFar && inHalf);
    });
  }

  it('folds the whole top half for the first wing, along the right line', () => {
    const st = plane.steps[4];
    expect(distToAxis(st, 0, P(C, H))).toBeLessThan(1e-6);
    expect(distToAxis(st, 0, P(U_TAIL, 0))).toBeLessThan(1e-6);
    checkWing(4, 'left');
  });

  it('folds the whole top half for the second wing, after the flip', () => {
    checkWing(6, 'right');
  });

  it('stacks layers without overlap: every landed flap sits above the paper below it', () => {
    for (const st of plane.steps.slice(0, 7)) {
      const ys = st.end.flatMap(f => f.world().map(v => v.y));
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1e-6);
      for (const f of st.end) {
        const w = f.world();
        const spread = Math.max(...w.map(v => v.y)) - Math.min(...w.map(v => v.y));
        expect(spread).toBeLessThan(1e-6); // flat folds stay flat
      }
    }
  });

  it('ends in a flight pose: nose forward, keel below, wings level-ish', () => {
    const st = plane.steps[7];
    const mats = stepMatrices(st, 1);
    const pts = st.faces.flatMap((f, i) => f.world(faceMatrix(st, i, mats)));
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y), zs = pts.map(p => p.z);
    const span = Math.max(...xs) - Math.min(...xs);
    const length = Math.max(...zs) - Math.min(...zs);
    const depth = Math.max(...ys) - Math.min(...ys);
    expect(length).toBeGreaterThan(H * 0.95);
    expect(span).toBeGreaterThan(8);
    expect(depth).toBeGreaterThan(4);
    expect(depth).toBeLessThan(span);
    expect(Math.min(...ys)).toBeGreaterThan(0); // floating above the mat
  });

  it('gives every fold and flip an arrow', () => {
    for (const st of plane.steps.slice(0, 7)) {
      st.ops.forEach((_, k) => expect(arrowPath(st, k)?.length).toBe(41));
    }
  });

  it('projects a thumbnail', () => {
    const { polygons, bounds } = projectFinal(plane);
    expect(polygons.length).toBe(plane.steps[7].faces.length);
    expect(bounds[2] - bounds[0]).toBeGreaterThan(5);
  });
});

describe('recipe errors read like instructions', () => {
  const base = spec;
  const withStep = (i: number, step: unknown) => ({ ...base, steps: base.steps.map((s, j) => (j === i ? step : s)) }) as PlaneSpec;

  it('names an unknown crease and lists the ones that exist', () => {
    const bad = withStep(1, { title: 'x', fold: { bring: 'corner:top-left', to: 'crease:middle', through: 'mid:edge:top' } });
    expect(() => compilePlane(bad)).toThrow(/Step 2: Unknown crease "middle". Creases so far: center/);
  });

  it('asks for "through" when bringing a point onto a line', () => {
    const bad = withStep(1, { title: 'x', fold: { bring: 'corner:top-left', to: 'crease:center' } });
    expect(() => compilePlane(bad)).toThrow(/needs "through"/);
  });

  it('flags malformed references before compiling', () => {
    const bad = withStep(0, { title: 'x', fold: { bring: 'left edge', to: 'edge:right' } });
    expect(validatePlane(bad)[0]).toMatchObject({ step: 0 });
  });
});
