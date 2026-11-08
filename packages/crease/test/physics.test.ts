import { describe, expect, it } from 'vitest';
import dart from '../../../planes/classic-dart.plane.json';
import { auditPlane, auditStep, compilePlane, PlaneError, type CompiledPlane, type PlaneSpec, type Step, type StepSpec } from '../src';

const plane = compilePlane(dart as PlaneSpec);

/** A copy of a step whose first op moves a different set of faces. */
function withMoving(st: Step, moving: boolean[]): Step {
  return { ...st, ops: st.ops.map((op, k) => (k === 0 ? { ...op, moving } : op)) };
}

describe('physical checks catch broken folds', () => {
  it('the classic dart passes every check', () => {
    expect(auditPlane(plane)).toEqual([]);
  });

  it('catches the corner flap that used to stay behind in a wing fold (paper through paper)', () => {
    const st = plane.steps[4];
    const stray = st.faces.findIndex((f, i) => st.ops[0].moving[i] && f.centroidFlat()[0] < 6 && f.centroidFlat()[1] > 26);
    expect(stray).toBeGreaterThanOrEqual(0);
    const moving = st.ops[0].moving.map((m, i) => (i === stray ? false : m));
    expect(auditStep(plane, withMoving(st, moving)).map(i => i.kind)).toContain('pierce');
  });

  it('catches a fold that leaves part of a connected flap behind (tear)', () => {
    const st = plane.steps[2]; // edges in again: each fold moves a base strip and part of a corner flap
    const moved = st.ops[0].moving.map((m, i) => (m ? i : -1)).filter(i => i >= 0);
    expect(moved.length).toBeGreaterThan(1);
    const moving = st.ops[0].moving.map((m, i) => (i === moved[0] ? false : m));
    const kinds = auditStep(plane, withMoving(st, moving)).map(i => i.kind);
    expect(kinds.some(k => k === 'tear' || k === 'pierce')).toBe(true);
  });

  it('catches paper going through the table', () => {
    const st = plane.steps[5]; // turn it over
    const op = { ...st.ops[0], hop: 0 };
    expect(auditStep(plane, { ...st, ops: [op] }).map(i => i.kind)).toContain('below-table');
  });
});

/* ---------- fuzz: random recipes must fold like real paper, or fail with a readable message ---------- */

function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PHYSICAL = /tear|through paper|through the table|lie flat|lost or gained paper|sliver/;
const CORNERS = ['corner:top-left', 'corner:top-right', 'corner:bottom-left', 'corner:bottom-right'];
const EDGES = ['edge:top', 'edge:bottom', 'edge:left', 'edge:right'];

function randomRecipe(seed: number): PlaneSpec {
  const r = mulberry32(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const at = () => `at:${r().toFixed(2)},${r().toFixed(2)}`;
  const steps: StepSpec[] = [];
  const n = 2 + Math.floor(r() * 5);
  for (let k = 0; k < n; k++) {
    const roll = r();
    if (roll < 0.12) { steps.push({ title: `flip ${k}`, flip: r() < 0.7 ? true : { axis: 'short' } }); continue; }
    const layers = r() < 0.35 ? 'top' as const : 'all' as const;
    const unfold = r() < 0.15;
    const kind = r();
    const fold = kind < 0.5
      ? { bring: pick(CORNERS), to: at(), layers, unfold }
      : kind < 0.8
        ? { bring: at(), to: at(), layers, unfold }
        : { bring: pick(EDGES), to: pick(EDGES), layers, unfold };
    steps.push({ title: `fold ${k}`, fold });
  }
  return { id: `fuzz-${seed}`, name: `Fuzz ${seed}`, paper: r() < 0.5 ? 'A4' : 'Letter', steps };
}

describe('fuzz: 1500 random recipes', () => {
  it('every recipe either folds like real paper, or fails with a step number and a reason', () => {
    let compiled = 0, rejected = 0, totalSteps = 0;
    const reasons = new Map<string, number>();
    for (let seed = 1; seed <= 1500; seed++) {
      const spec = randomRecipe(seed);
      let p: CompiledPlane | undefined;
      try {
        p = compilePlane(spec);
      } catch (e) {
        // Must be a clean, explained rejection, never a crash.
        expect(e, `seed ${seed}: ${(e as Error).stack}`).toBeInstanceOf(PlaneError);
        expect((e as Error).message).toMatch(/^Step \d+: .{10,}/);
        // Random folds are all physically possible: if a physical check fails, the engine moved
        // the paper wrongly. Only recipe problems (fold misses the sheet, nothing to fold) may reject.
        expect((e as Error).message, `seed ${seed} hit an engine bug`).not.toMatch(PHYSICAL);
        rejected++;
        const why = (e as Error).message.replace(/^Step \d+: /, '').slice(0, 40);
        reasons.set(why, (reasons.get(why) ?? 0) + 1);
        continue;
      }
      compiled++;
      totalSteps += p.steps.length;
      // compilePlane already refuses anything that fails the checks; assert it anyway, plus sanity on the numbers.
      expect(auditPlane(p), `seed ${seed}`).toEqual([]);
      for (const st of p.steps) {
        for (const f of st.end) for (const v of f.world()) expect(Number.isFinite(v.x + v.y + v.z), `seed ${seed}`).toBe(true);
      }
    }
    // Make sure the test exercises real folding, not just rejections.
    expect(compiled).toBeGreaterThan(1000);
    expect(totalSteps).toBeGreaterThan(4000);
    console.log(`fuzz: ${compiled} recipes folded (${totalSteps} steps), ${rejected} rejected with reasons:`, Object.fromEntries(reasons));
  });
});
