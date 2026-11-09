import { describe, expect, it } from 'vitest';
import dart from '../../../planes/classic-dart.plane.json';
import nakamura from '../../../planes/nakamura-lock.plane.json';
import { PlaneError, compilePlane, compilePlaneSoFar, describeAfter, measureFinished, projectStep, refsAt, stepsSheetSvg, type PlaneSpec } from '../src';

const plane = compilePlane(dart as PlaneSpec);

describe('refsAt', () => {
  it('offers the flat sheet before the first step', () => {
    const r = refsAt(plane, 0);
    expect(r.step).toBe(1);
    expect(r.usable.find(u => u.ref === 'corner:top-right')?.at).toEqual([21, 29.7]);
    expect(r.usable.some(u => u.ref.startsWith('crease:'))).toBe(false);
  });

  it('adds each crease from the step after it is made', () => {
    const r = refsAt(plane, 1);
    const center = r.usable.find(u => u.ref === 'crease:center');
    expect(center).toMatchObject({ kind: 'line', madeIn: 1, from: [10.5, 0], to: [10.5, 29.7] });
    expect(r.usable.find(u => u.ref === 'mid:crease:center')?.at).toEqual([10.5, 14.9]);
  });

  it('shows where a folded corner is now', () => {
    const r = refsAt(plane, 2);
    // Step 2 brings the top corners to the centre crease.
    expect(r.usable.find(u => u.ref === 'corner:top-left')?.at?.[0]).toBeCloseTo(10.5, 1);
  });

  it('refuses steps beyond what folds', () => {
    expect(() => refsAt(plane, plane.steps.length + 1)).toThrow(/isn't available/);
  });
});

describe('describeAfter', () => {
  it('counts layers as they stack up', () => {
    const layers = plane.steps.filter(s => s.view === 'table').map((_, i) => describeAfter(plane, i).maxLayers);
    expect(layers[0]).toBe(1); // creased and opened flat again
    expect(layers[1]).toBe(2); // corners folded over
    for (let i = 1; i < layers.length; i++) expect(layers[i]!).toBeGreaterThanOrEqual(layers[i - 1]!);
  });

  it('halves the width when the plane is folded in half', () => {
    const half = plane.spec.steps.findIndex(s => s.title === 'Fold in half');
    expect(describeAfter(plane, half).size?.width).toBeCloseTo(10.5, 1);
  });

  it('lists creases with the step that made them', () => {
    const r = describeAfter(plane, 1);
    expect(r.creases.map(c => [c.id, c.madeIn])).toEqual([['center', 1], ['corner-left', 2], ['corner-right', 2]]);
  });
});

describe('measureFinished', () => {
  it('measures the finished plane in flight', () => {
    const dartM = measureFinished(plane)!;
    const nak = measureFinished(compilePlane(nakamura as PlaneSpec))!;
    expect(dartM.length).toBeGreaterThan(25);
    // The Nakamura's point folds down to 2.5 cm from the bottom, so it is about (29.7 + 2.5) / 2 long.
    expect(nak.length).toBeCloseTo(16.1, 0);
    // Its wings fold 2.5 cm from the belly.
    expect(nak.bodyDepth).toBeCloseTo(2.5, 0);
    expect(nak.wingspan).toBeGreaterThan(dartM.wingspan);
  });
});

describe('errors', () => {
  it('report the step that fails, with and without the "Step N:" prefix', () => {
    const spec = structuredClone(dart) as PlaneSpec;
    // Folding along the centre crease again, once the plane is already folded in half, moves all of the paper.
    spec.steps.splice(4, 0, { title: 'Bad fold', fold: { along: 'crease:center', move: 'corner:bottom-right', layers: 'top' } });
    const { plane: partial, error } = compilePlaneSoFar(spec);
    expect(error?.step).toBe(4);
    expect(partial.steps).toHaveLength(4);
    expect(error?.message).toBe(`Step 5: ${error?.detail}`);
  });

  it('carry every physical problem on the failing step', () => {
    const issues = [{ step: 2, kind: 'tear' as const, message: 'a' }, { step: 2, kind: 'pierce' as const, message: 'b' }];
    const e = new PlaneError(2, 'a', issues);
    expect(e.issues).toHaveLength(2);
  });
});

describe('drawing order', () => {
  it('draws a flap folded on top above the paper under it', () => {
    // After step 2 the folded corners lie on top, back side up. Seen at an angle they must still be drawn last.
    const p = projectStep(plane, 1, 1);
    expect(p.polygons.at(-1)?.side).toBe('back');
  });

  it('draws the same sheet every time', () => {
    expect(stepsSheetSvg(plane)).toBe(stepsSheetSvg(compilePlane(dart as PlaneSpec)));
  });
});
