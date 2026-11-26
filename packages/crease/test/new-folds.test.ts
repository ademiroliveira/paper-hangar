import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import valkyrie from '../../../planes/valkyrie.plane.json';
import { auditPlane, compilePlane, compilePlaneSoFar, faceMatrix, stepMatrices, type PlaneSpec, type StepSpec } from '../src';
import { components, sharedSegments } from '../src/geometry';

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

describe('squash fold', () => {
  // Fold in half, fold the top 9.7 cm down through both layers: a two-layer flap hinged on y = 20,
  // with its folded edge (the spine) running down from the hinge at x = 10.5.
  const flapSteps: StepSpec[] = [
    halve,
    { title: 'Top down', fold: { id: 'strip', line: ['at:0.5,0.6734', 'at:1,0.6734'], move: 'at:0.9,0.95' } },
  ];
  const P = { x: 10.5, y: 20 };
  const table = (v: Vector3) => ({ x: v.x, y: -v.z });
  const endOf = (st: ReturnType<typeof compilePlane>['steps'][number]) => {
    const mats = stepMatrices(st, 1);
    return st.faces.map((f, i) => ({ f, M: faceMatrix(st, i, mats) }));
  };
  /** Where the flap's spine (the folded edge from the first step) ends up, on the table. */
  const spineAfter = (plane: ReturnType<typeof compilePlane>) => {
    const st = plane.steps[plane.steps.length - 1];
    const pts: { x: number; y: number }[] = [];
    for (const { f, M } of endOf(st)) for (const p of f.poly) {
      if (Math.abs(p[0] - 10.5) < 1e-6 && p[1] > 20 - 1e-6) pts.push(table(new Vector3(p[0], 0, -p[1]).applyMatrix4(M)));
    }
    return pts;
  };

  it('squashes the flap into a triangle, its folded edge along the hinge', () => {
    const plane = compilePlane(recipe([...flapSteps, { title: 'Squash', fold: { id: 'sq', squash: 'crease:strip', to: 'crease:strip' } }]));
    expect(auditPlane(plane)).toEqual([]);
    const pts = spineAfter(plane);
    expect(pts.length).toBeGreaterThan(1);
    for (const p of pts) {
      expect(p.y).toBeCloseTo(P.y, 3);
      expect(p.x).toBeGreaterThanOrEqual(P.x - 1e-3);
      expect(p.x).toBeLessThanOrEqual(P.x + 9.7 + 1e-3);
    }
    // Half the flap now lies above the hinge, half below: a symmetric triangle.
    const moved = plane.steps[2].end.filter(f => f.tags.has('moved:sq'));
    const ys = moved.flatMap(f => f.world().map(v => -v.z));
    expect(Math.max(...ys)).toBeCloseTo(29.7, 3);
    expect(Math.min(...ys)).toBeCloseTo(10.3, 3);
    // It makes two creases, one in each layer, mirrored across the hinge.
    expect(plane.creases.map(c => c.id)).toEqual(expect.arrayContaining(['sq', 'sq-2']));
  });

  it('keeps the two layers joined along the folded edge where they land', () => {
    const plane = compilePlane(recipe([...flapSteps, { title: 'Squash', fold: { id: 'sq', squash: 'crease:strip', to: 'crease:strip' } }]));
    const st = plane.steps[2];
    const mats = stepMatrices(st, 1);
    for (let i = 0; i < st.faces.length; i++) for (let j = i + 1; j < st.faces.length; j++) {
      for (const seg of sharedSegments(st.faces[i], st.faces[j])) for (const p of seg) {
        const a = new Vector3(p[0], 0, -p[1]).applyMatrix4(faceMatrix(st, i, mats));
        const b = new Vector3(p[0], 0, -p[1]).applyMatrix4(faceMatrix(st, j, mats));
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(1e-3);
      }
    }
  });

  it('lays each layer\'s outer part on top of its inner part, inside surfaces together', () => {
    const plane = compilePlane(recipe([...flapSteps, { title: 'Squash', fold: { id: 'sq', squash: 'crease:strip', to: 'crease:strip' } }]));
    const end = plane.steps[2].end;
    // The top of the stack is the flap's outer part: it shows the side that faced out before the squash.
    const top = end.reduce((a, b) => (b.maxY() > a.maxY() ? b : a));
    expect(top.tags.has('moved:sq')).toBe(true);
    // Paper that stayed put is never above paper that moved, where they overlap.
    for (const a of end) for (const b of end) {
      if (a.tags.has('moved:sq') || !b.tags.has('moved:sq')) continue;
      const overlap = Math.min(a.maxY(), b.maxY()) >= 0 && a.world().some(() => true);
      if (overlap && a.maxY() > b.maxY() + 1e-6) {
        const ax = a.world().map(v => [v.x, v.z]), bx = b.world().map(v => [v.x, v.z]);
        const minx = (s: number[][]) => Math.min(...s.map(p => p[0])), maxx = (s: number[][]) => Math.max(...s.map(p => p[0]));
        const minz = (s: number[][]) => Math.min(...s.map(p => p[1])), maxz = (s: number[][]) => Math.max(...s.map(p => p[1]));
        const disjoint = maxx(ax) <= minx(bx) + 1e-4 || maxx(bx) <= minx(ax) + 1e-4 || maxz(ax) <= minz(bx) + 1e-4 || maxz(bx) <= minz(ax) + 1e-4;
        expect(disjoint).toBe(true);
      }
    }
  });

  it('lands the folded edge on a point when the squash isn\'t symmetric', () => {
    // A point on the base, about 20° below the hinge.
    const plane = compilePlane(recipe([...flapSteps, { title: 'Squash', fold: { id: 'sq', squash: 'crease:strip', to: 'at:0.9524,0.5556' } }]));
    expect(auditPlane(plane)).toEqual([]);
    const want = Math.atan2(16.5 - P.y, 20 - P.x);
    for (const p of spineAfter(plane)) {
      if (Math.hypot(p.x - P.x, p.y - P.y) < 0.5) continue;
      expect(Math.atan2(p.y - P.y, p.x - P.x)).toBeCloseTo(want, 3);
    }
  });

  it('refuses a single layer: there is no pocket to open', () => {
    const { error } = compilePlaneSoFar(recipe([
      { title: 'Top down', fold: { id: 'strip', line: ['at:0,0.6734', 'at:1,0.6734'], move: 'at:0.5,0.95' } },
      { title: 'Squash', fold: { squash: 'crease:strip', to: 'at:0.9,0.5' } },
    ]));
    expect(error?.step).toBe(1);
    expect(error?.detail).toMatch(/two layers/);
  });

  it('refuses a flap with paper on top of it', () => {
    const { error } = compilePlaneSoFar(recipe([
      ...flapSteps,
      { title: 'Bottom up', fold: { line: ['at:0.5,0.5', 'at:1,0.5'], move: 'at:0.9,0.1' } },
      { title: 'Squash', fold: { squash: 'crease:strip', to: 'crease:strip', flap: 'at:0.9,0.9' } },
    ]));
    expect(error?.step).toBe(3);
    expect(error?.detail).toMatch(/on top/);
  });

  it('refuses a landing line that misses where the edge meets the hinge', () => {
    const { error } = compilePlaneSoFar(recipe([...flapSteps, { title: 'Squash', fold: { squash: 'crease:strip', to: 'edge:right' } }]));
    expect(error?.detail).toMatch(/can only land on a line through that point/);
  });

  it('checks the recipe shape: a squash needs "to" and is a step of its own', () => {
    const { error } = compilePlaneSoFar(recipe([...flapSteps, { title: 'Squash', fold: { squash: 'crease:strip' } as never }]));
    expect(error?.detail).toMatch(/needs "to"/);
  });
});

/* ---------- fuzz: random squashes fold like real paper, or are refused with a reason ---------- */

function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('fuzz: 400 random squash folds', () => {
  it('every one either folds like real paper or is refused with a reason', () => {
    let folded = 0;
    const why = new Map<string, number>();
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      // Fold in half along a random line, fold the end over through both layers, then squash it somewhere.
      const half: StepSpec = r() < 0.5 ? halve : { title: 'Half', fold: { id: 'half', bring: 'edge:bottom', to: 'edge:top' } };
      const y = (0.55 + r() * 0.3).toFixed(3), x = (0.55 + r() * 0.3).toFixed(3);
      const end: StepSpec = half === halve
        ? { title: 'End over', fold: { id: 'hinge', line: [`at:0.5,${y}`, `at:1,${y}`], move: 'at:0.9,0.99' } }
        : { title: 'End over', fold: { id: 'hinge', line: [`at:${x},0.5`, `at:${x},1`], move: 'at:0.99,0.9' } };
      const to = `at:${(0.3 + r() * 0.7).toFixed(3)},${(0.05 + r() * 0.9).toFixed(3)}`;
      const spec = recipe([half, end, { title: 'Squash', fold: { id: 'sq', squash: 'crease:hinge', to } }]);
      try {
        const plane = compilePlane(spec);
        expect(auditPlane(plane), `seed ${seed}`).toEqual([]);
        folded++;
      } catch (e) {
        expect((e as Error).message, `seed ${seed}`).toMatch(/^Step \d+: .{10,}/);
        expect((e as Error).message, `seed ${seed} hit an engine bug`).not.toMatch(/tear|through paper|through the table|lie flat|lost or gained paper|sliver/);
        const reason = (e as Error).message.replace(/^Step \d+: /, '').slice(0, 50);
        why.set(reason, (why.get(reason) ?? 0) + 1);
      }
    }
    console.log(`squash fuzz: ${folded} of 400 folded`, Object.fromEntries(why));
    expect(folded).toBeGreaterThan(100);
  });
});
