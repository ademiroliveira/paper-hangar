import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import valkyrie from '../../../planes/valkyrie.plane.json';
import { auditPlane, compilePlane, compilePlaneSoFar, faceMatrix, stepMatrices, validatePlane, type PlaneSpec, type StepSpec } from '../src';
import { components, overlapsFromAbove, sharedSegments } from '../src/geometry';

const recipe = (steps: StepSpec[]): PlaneSpec => ({ id: 'test', name: 'Test', paper: 'A4', steps });
const halve: StepSpec = { title: 'Fold in half', fold: { id: 'half', bring: 'edge:left', to: 'edge:right' } };
const normal = (vs: Vector3[]) => new Vector3().crossVectors(vs[1].clone().sub(vs[0]), vs[2].clone().sub(vs[0])).normalize();

describe('inside reverse fold', () => {
  // Folded in half, the sheet is a pocket joined along the middle. Reverse the top of it in.
  const spec = recipe([
    halve,
    { title: 'Reverse the top in', fold: { id: 'rev', bring: 'mid:edge:top', to: 'at:0.5,0.8', reverse: 'inside' } },
  ]);

  it('folds cleanly and passes every physical check', () => {
    const plane = compilePlane(spec);
    expect(auditPlane(plane)).toEqual([]);
  });

  it('puts the turned-in paper between the two sides of the pocket', () => {
    const plane = compilePlane(spec);
    const end = plane.steps[1].end;
    const moved = end.filter(f => f.tags.has('moved:rev'));
    const still = end.filter(f => !f.tags.has('moved:rev'));
    expect(moved.length).toBeGreaterThanOrEqual(2);
    const lo = Math.min(...still.map(f => f.maxY())), hi = Math.max(...still.map(f => f.maxY()));
    for (const f of moved) {
      expect(f.maxY()).toBeGreaterThan(lo);
      expect(f.maxY()).toBeLessThan(hi);
    }
    // Nothing sticks out above the fold line any more (y = 0.8 * 29.7 + half the distance to the top).
    const line = (29.7 + 0.8 * 29.7) / 2;
    for (const f of end) for (const v of f.world()) expect(-v.z).toBeLessThanOrEqual(line + 1e-6);
  });

  it('keeps the two sides joined where they land', () => {
    const plane = compilePlane(spec);
    const st = plane.steps[1];
    const mats = stepMatrices(st, 1);
    for (let i = 0; i < st.faces.length; i++) for (let j = i + 1; j < st.faces.length; j++) {
      for (const seg of sharedSegments(st.faces[i], st.faces[j])) for (const p of seg) {
        const a = new Vector3(p[0], 0, -p[1]).applyMatrix4(faceMatrix(st, i, mats));
        const b = new Vector3(p[0], 0, -p[1]).applyMatrix4(faceMatrix(st, j, mats));
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1e-3);
      }
    }
  });

  it('refuses a single layer: there is no pocket to turn into', () => {
    const { error } = compilePlaneSoFar(recipe([
      { title: 'Reverse', fold: { bring: 'corner:top-left', to: 'at:0.2,0.8', reverse: 'inside' } },
    ]));
    expect(error?.detail).toMatch(/needs a pocket/);
  });
});

describe('swivel fold', () => {
  // Fold the top 5 cm down: a band joined to the sheet along y = 24.7 (a pocket). Then swivel its right
  // part over a 45° line through (15, 24.7): the band folds over, its end swivels down on top, and the
  // sheet's corner folds in along x + y = 39.7.
  const band: StepSpec = { title: 'Top down', fold: { id: 'top', parallel: 'edge:bottom', distance: 24.7, move: 'mid:edge:top' } };
  const swivel: StepSpec = {
    title: 'Swivel',
    fold: { id: 'sw', line: ['at:0.714286,0.831650', 'at:0.476190,0.663300'], move: 'at:0.952381,0.707071', flap: 'at:0.857143,0.922559', swivel: true },
  };
  const side = (f: { world(): Vector3[] }) => {
    const w = f.world();
    let a = 0;
    for (let i = 0; i < w.length; i++) { const p = w[i], q = w[(i + 1) % w.length]; a += p.x * -q.z - q.x * -p.z; }
    return Math.sign(a);
  };
  const inside = (f: { world(): Vector3[] }, x: number, y: number) => {
    const w = f.world();
    let s = 0;
    for (let i = 0; i < w.length; i++) {
      const a = w[i], b = w[(i + 1) % w.length];
      const c = (b.x - a.x) * (-y - a.z) - (b.z - a.z) * (x - a.x);
      if (Math.abs(c) < 1e-9) continue;
      if (s && Math.sign(c) !== s) return false;
      s = Math.sign(c);
    }
    return true;
  };

  it('folds cleanly and passes every physical check', () => {
    const plane = compilePlane(recipe([band, swivel]));
    expect(auditPlane(plane)).toEqual([]);
  });

  it('leaves a straight slant where the corner was', () => {
    const end = compilePlane(recipe([band, swivel])).steps[1].end;
    for (const f of end) for (const v of f.world()) if (-v.z > 18.7 + 1e-6) expect(v.x - v.z).toBeLessThanOrEqual(39.7 + 1e-3);
  });

  it('turns the band\'s end down on top of the part folded over the line', () => {
    const end = compilePlane(recipe([band, swivel])).steps[1].end;
    // At (11, 23): the end of the band on top, back side up; under it the folded-over part, front side up.
    const stack = end.filter(f => inside(f, 11, 23)).sort((a, b) => b.maxY() - a.maxY());
    expect(stack[0].tags.has('moved:sw')).toBe(true);
    expect(stack[1].tags.has('moved:sw')).toBe(true);
    expect(side(stack[0])).toBe(-1);
    expect(side(stack[1])).toBe(1);
    // The sheet's corner now lies folded in at (19, 20), back side up.
    const corner = end.filter(f => inside(f, 19, 20)).sort((a, b) => b.maxY() - a.maxY())[0];
    expect(corner.tags.has('moved:sw')).toBe(true);
    expect(side(corner)).toBe(-1);
  });

  it('refuses a flap that isn\'t joined to anything under it', () => {
    const { error } = compilePlaneSoFar(recipe([
      { title: 'Swivel', fold: { line: ['mid:edge:top', 'at:0,0.5'], move: 'corner:top-left', flap: 'corner:top-left', swivel: true } },
    ]));
    expect(error?.detail).toMatch(/needs a pocket/);
  });
});

describe('flap', () => {
  const corners: StepSpec = {
    title: 'Corners in',
    folds: [
      { id: 'cl', bring: 'corner:top-left', to: 'edge:right', through: 'mid:edge:top' },
      { id: 'cr', bring: 'corner:top-right', to: 'edge:left', through: 'mid:edge:top' },
    ],
  };

  it('folds only the flap that holds the point', () => {
    const spec: PlaneSpec = {
      id: 'test', name: 'Test', paper: 'A4',
      steps: [
        { title: 'Center', fold: { id: 'center', bring: 'edge:left', to: 'edge:right', unfold: true } },
        { title: 'Corners in', folds: [
          { id: 'cl', bring: 'corner:top-left', to: 'crease:center', through: 'mid:edge:top' },
          { id: 'cr', bring: 'corner:top-right', to: 'crease:center', through: 'mid:edge:top' },
        ] },
        { title: 'Fold the left flap back', fold: { id: 'back', parallel: 'crease:cl', distance: 2, move: 'corner:top-left', flap: 'corner:top-left' } },
      ],
    };
    const plane = compilePlane(spec);
    expect(auditPlane(plane)).toEqual([]);
    const moved = plane.steps[2].end.filter(f => f.tags.has('moved:back'));
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.every(f => f.tags.has('moved:cl') && !f.tags.has('moved:cr'))).toBe(true);
  });

  it('says so when the point is not on paper the fold moves', () => {
    const { error } = compilePlaneSoFar(recipe([
      corners,
      { title: 'Fold', fold: { parallel: 'edge:bottom', distance: 5, move: 'mid:edge:top', flap: 'corner:bottom-left' } },
    ]));
    expect(error?.detail).toMatch(/isn't on the paper this fold moves/);
  });
});

describe('cut', () => {
  const spec = recipe([
    halve,
    { title: 'Slit', cut: { slits: [['at:0.75,0', 'at:0.75,0.1']] } },
  ]);

  it('cuts through every layer and keeps the sheet whole', () => {
    const plane = compilePlane(spec);
    expect(auditPlane(plane)).toEqual([]);
    expect(plane.cuts.length).toBe(2);
    const area = plane.steps[1].end.reduce((s, f) => s + f.area(), 0);
    expect(area).toBeCloseTo(21 * 29.7, 6);
  });

  it('leaves the paper unjoined along the slit, and joined past its end', () => {
    const plane = compilePlane(spec);
    const end = plane.steps[1].end;
    // The slit runs up from the bottom edge at x = 15.75 cm on the table: x = 15.75 on the bottom layer
    // and x = 5.25 on the layer folded over it. Faces either side touch there, but the cut separates them.
    const onSlit = ([p, q]: [number, number][]) =>
      [15.75, 5.25].some(x => Math.abs(p[0] - x) < 1e-6 && Math.abs(q[0] - x) < 1e-6) && Math.max(p[1], q[1]) <= 2.97 + 1e-6;
    const pairsOnSlit = end.flatMap((a, i) => end.slice(i + 1).map(b => [a, b] as const))
      .filter(([a, b]) => sharedSegments(a, b).some(onSlit));
    expect(pairsOnSlit.length).toBe(2);
    for (const [a, b] of pairsOnSlit) expect(sharedSegments(a, b, plane.cuts).filter(onSlit)).toEqual([]);
    // Each layer is still one piece of paper: the slit doesn't cut it in two.
    const layers = new Map<number, typeof end>();
    for (const f of end) { const k = Math.round(f.maxY() * 100); layers.set(k, [...(layers.get(k) ?? []), f]); }
    for (const fs of layers.values()) expect(components(fs, plane.cuts).length).toBe(1);
  });

  it('refuses a slit with no length', () => {
    const { error } = compilePlaneSoFar(recipe([halve, { title: 'Slit', cut: { slits: [['at:0.75,0.5', 'at:0.75,0.5']] } }]));
    expect(error?.detail).toMatch(/has no length/);
  });
});

describe('fold on a line through two points', () => {
  it('creases exactly on that line', () => {
    const plane = compilePlane(recipe([
      { title: 'Diagonal', fold: { id: 'diag', line: ['mid:edge:top', 'corner:bottom-left'], move: 'corner:top-left' } },
    ]));
    expect(auditPlane(plane)).toEqual([]);
    const segs = plane.creases.find(c => c.id === 'diag')!.segs;
    expect(segs.length).toBeGreaterThan(0);
    // The line from (10.5, 29.7) to (0, 0): every crease point satisfies 29.7·x − 10.5·y = 0.
    for (const [p, q] of segs) for (const [x, y] of [p, q]) expect(Math.abs(29.7 * x - 10.5 * y)).toBeLessThan(1e-6);
  });

  it('refuses two points in the same place', () => {
    const { error } = compilePlaneSoFar(recipe([
      { title: 'Nothing', fold: { line: ['corner:top-left', 'corner:top-left'], move: 'corner:bottom-right' } },
    ]));
    expect(error?.detail).toMatch(/don't make a line/);
  });
});

describe('cut tabs', () => {
  const slits: [string, string][] = [['at:0.6,0', 'at:0.6,0.05'], ['at:0.8,0', 'at:0.8,0.05']];

  it('names the paper between two slits, in every layer, and records its hinge', () => {
    const plane = compilePlane(recipe([halve, { title: 'Elevator', cut: { slits, tab: 'elevator' } }]));
    expect(auditPlane(plane)).toEqual([]);
    const tab = plane.steps[1].end.filter(f => f.tags.has('tab:elevator'));
    expect(new Set(tab.map(f => Math.round(f.maxY() * 100))).size).toBe(2);
    // Each layer's tab is the 4.2 × 1.485 cm strip between the slits.
    expect(tab.reduce((s, f) => s + f.area(), 0)).toBeCloseTo(2 * 4.2 * 1.485, 6);
    expect(plane.creases.some(c => c.id === 'elevator' && c.named)).toBe(true);
  });

  it('needs exactly two slits', () => {
    const { error } = compilePlaneSoFar(recipe([halve, { title: 'Cut', cut: { slits: [slits[0]], tab: 'elevator' } }]));
    expect(error?.detail).toMatch(/exactly two slits/);
  });
});

describe('cutting a piece off', () => {
  // Cut the top 2.97 cm off an A4 sheet, then fold the new top-left corner down.
  const trim: StepSpec = { title: 'Trim', cut: { slits: [['at:0,0.9', 'at:1,0.9']], remove: 'at:0.5,0.95' } };

  it('removes the piece, and later steps refer to what is left', () => {
    const plane = compilePlane(recipe([
      trim,
      { title: 'Corner', fold: { id: 'corner', bring: 'corner:top-left', to: 'at:0.5,1', through: 'at:0,0.5' } },
    ]));
    expect(auditPlane(plane)).toEqual([]);
    expect(plane.trims).toEqual([{ step: 0, area: expect.closeTo(21 * 26.73, 6), sheet: { x: 0, y: 0, w: 21, h: expect.closeTo(26.73, 6) } }]);
    expect(plane.steps[0].end.reduce((a, f) => a + f.area(), 0)).toBeCloseTo(21 * 26.73, 6);
    // corner:top-left is now (0, 26.73), the corner of the trimmed sheet, not of the A4 sheet.
    const moved = plane.steps[1].end.filter(f => f.tags.has('moved:corner'));
    expect(moved.some(f => f.poly.some(([x, y]) => Math.abs(x) < 1e-6 && Math.abs(y - 26.73) < 1e-6))).toBe(true);
  });

  it('slides the piece away while the step plays', () => {
    const st = compilePlane(recipe([trim])).steps[0];
    const off = st.ops.find(o => o.kind === 'cut' && o.moving.some(Boolean));
    expect(off).toBeDefined();
    expect(st.faces.filter((f, i) => off!.moving[i]).every(f => f.tags.has('removed'))).toBe(true);
  });

  it('refuses a piece the slits do not cut free', () => {
    const { error } = compilePlaneSoFar(recipe([{ title: 'Trim', cut: { slits: [['at:0,0.9', 'at:0.6,0.9']], remove: 'at:0.5,0.95' } }]));
    expect(error?.detail).toMatch(/don't cut the piece/);
  });
});

describe('fins in the flight pose', () => {
  it('stand upright on the Valkyrie wings', () => {
    const plane = compilePlane(valkyrie as PlaneSpec);
    const st = plane.steps.at(-1)!;
    const mats = stepMatrices(st, 1);
    for (const fin of ['fin-1', 'fin-2']) {
      const i = st.faces.findIndex(f => f.tags.has(`moved:${fin}`) && f.area() > 1);
      const j = st.faces.findIndex((f, k) => k !== i && !f.tags.has(`moved:${fin}`) && sharedSegments(st.faces[i], f).length);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(j).toBeGreaterThanOrEqual(0);
      const a = normal(st.faces[i].world(faceMatrix(st, i, mats))), b = normal(st.faces[j].world(faceMatrix(st, j, mats)));
      expect(Math.abs(a.dot(b))).toBeLessThan(0.05);
    }
  });

  it('bends the elevator tab up on both wings', () => {
    const plane = compilePlane(valkyrie as PlaneSpec);
    const st = plane.steps.at(-1)!;
    const tabOps = st.ops.filter(o => o.kind === 'pose' && st.faces.some((f, i) => o.moving[i] && f.tags.has('tab:elevator')) && o.moving.filter(Boolean).length < 4);
    expect(tabOps.length).toBe(2);
    for (const op of tabOps) {
      const i = op.moving.indexOf(true), f = st.faces[i];
      const dist = (v: Vector3) => v.clone().sub(op.pivot).setY(0).cross(op.axis).length();
      const far = f.world().reduce((m, v) => (dist(v) > dist(m) ? v : m));
      const local = far.clone().applyMatrix4(f.M.clone().invert());
      const bent = local.clone().applyMatrix4(faceMatrix(st, i, stepMatrices(st, 1))).y;
      const saved = op.angle;
      op.angle = 0;
      const flat = local.clone().applyMatrix4(faceMatrix(st, i, stepMatrices(st, 1))).y;
      op.angle = saved;
      expect(bent).toBeGreaterThan(flat + 0.2);
    }
  });
});

describe('tuck', () => {
  // Fold the top 14 cm of an A4 sheet down: the band is a pocket, open along its lower edge (y = 1.7).
  // Then fold the bottom 1.7 cm up along that edge and tuck it in.
  const band: StepSpec = { title: 'Band', fold: { id: 'band', parallel: 'edge:bottom', distance: 15.7, move: 'mid:edge:top' } };
  const strip = (tuck: { flap: string; under: string }, distance = 1.7): StepSpec =>
    ({ title: 'Strip', fold: { id: 'strip', parallel: 'edge:bottom', distance, move: 'at:0.5,0.01', tuck } });

  it('slides the flap in under the paper it lands on, and passes every physical check', () => {
    const plane = compilePlane(recipe([band, strip({ flap: 'at:0.5,0.02', under: 'band' })]));
    expect(auditPlane(plane)).toEqual([]);
    const end = plane.steps[1].end;
    const sheet = end.filter(f => f.tags.size === 0 || ![...f.tags].some(t => t.startsWith('moved:')));
    const bandFaces = end.filter(f => f.tags.has('moved:band'));
    const stripFaces = end.filter(f => f.tags.has('moved:strip'));
    expect(stripFaces.length).toBeGreaterThan(0);
    for (const s of stripFaces) {
      expect(s.maxY()).toBeGreaterThan(Math.max(...sheet.map(f => f.maxY())));
      expect(s.maxY()).toBeLessThan(Math.min(...bandFaces.map(f => f.maxY())));
    }
  });

  it('plays the tuck after the fold has landed', () => {
    const st = compilePlane(recipe([band, strip({ flap: 'at:0.5,0.02', under: 'band' })])).steps[1];
    const tuck = st.ops.filter(o => o.kind === 'tuck');
    expect(tuck.length).toBe(1);
    expect(tuck[0].tr!.y).toBeLessThan(0);
    expect(tuck[0].prof(0.7)).toBe(0);
  });

  it('refuses a flap that is joined on two sides', () => {
    // Folded on the band's lower edge but long enough to stick out past the top: it can't slide in.
    const { error } = compilePlaneSoFar(recipe([
      { title: 'Band', fold: { id: 'band', parallel: 'edge:bottom', distance: 23.7, move: 'mid:edge:top' } },
      strip({ flap: 'at:0.5,0.5', under: 'band' }, 17.7),
    ]));
    expect(error?.detail).toMatch(/more than one line/);
  });

  it('says so when the flap does not land on that paper', () => {
    const { error } = compilePlaneSoFar(recipe([band, strip({ flap: 'at:0.5,0.02', under: 'band' }, 1)]));
    expect(error?.detail).toMatch(/doesn't land on paper from "band"/);
  });

  it('needs the id of an earlier fold to tuck under', () => {
    const problems = validatePlane(recipe([band, strip({ flap: 'at:0.5,0.02', under: 'later' })]));
    expect(problems.map(p => p.message).join(' ')).toMatch(/"tuck.under" must be the id of an earlier fold/);
  });

  it('locks the Valkyrie: the end of each swivelled band goes under the middle section', () => {
    const plane = compilePlane(valkyrie as PlaneSpec);
    for (const [k, side] of [[10, 'right'], [11, 'left']] as const) {
      const end = plane.steps[k].end;
      const flap = end.filter(f => f.tags.has(`moved:swivel-${side}`) && f.tags.has(`moved:side-${side}`));
      const middle = end.filter(f => f.tags.has('moved:point') && f.tags.has('moved:top') && !f.tags.has(`moved:side-${side}`));
      const tucked = flap.filter(f => middle.some(m => overlapsFromAbove(f, m) && f.maxY() < m.maxY()));
      expect(tucked.length).toBeGreaterThan(0);
      for (const f of flap) for (const m of middle) if (overlapsFromAbove(f, m)) expect(f.maxY()).toBeLessThan(m.maxY());
    }
  });
});
