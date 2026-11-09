import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  compilePlaneSoFar, describeAfter, measureFinished, refsAt, validatePlane,
  type CompiledPlane, type FinishedMeasures, type PlaneSpec, type RefsReport, type StateReport,
} from '@paper-hangar/crease';

/** Every report counts steps from 1, the way the app and the recipe's readers do. */

export type ProblemKind = 'json' | 'file' | 'schema' | 'structure' | 'fold' | 'sheet' | 'tear' | 'pierce' | 'below-table' | 'not-flat';
export interface Problem { step: number | null; kind: ProblemKind; message: string }

export interface CheckReport {
  file: string;
  id?: string;
  ok: boolean;
  /** Steps in the recipe. */
  steps: number;
  /** Steps that fold cleanly, counted from the start. Absent for `validate`, which doesn't fold. */
  folded?: number;
  problems: Problem[];
}

const require = createRequire(import.meta.url);
const schema = JSON.parse(readFileSync(require.resolve('@paper-hangar/crease/plane.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaCheck = ajv.compile(schema);

export function loadSpec(file: string): { spec?: PlaneSpec; problem?: Problem } {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    return { problem: { step: null, kind: 'file', message: `Can't read ${file}: ${(e as Error).message}` } };
  }
  try { return { spec: JSON.parse(text) as PlaneSpec }; } catch (e) {
    return { problem: { step: null, kind: 'json', message: `Not valid JSON: ${(e as Error).message}` } };
  }
}

function structureProblems(file: string, spec: PlaneSpec): Problem[] {
  const out: Problem[] = [];
  if (spec.id && basename(file) !== `${spec.id}.plane.json` && basename(file).endsWith('.plane.json')) {
    out.push({ step: null, kind: 'file', message: `The file is named ${basename(file)} but the id is "${spec.id}". Name it ${spec.id}.plane.json.` });
  }
  if (!schemaCheck(spec)) {
    for (const e of schemaCheck.errors ?? []) {
      const m = /^\/steps\/(\d+)/.exec(e.instancePath);
      const where = e.instancePath || '(top level)';
      const extra = e.params && 'allowedValues' in e.params ? ` (${(e.params.allowedValues as unknown[]).join(', ')})` : '';
      out.push({ step: m ? Number(m[1]) + 1 : null, kind: 'schema', message: `${where} ${e.message}${extra}` });
    }
  }
  for (const p of validatePlane(spec)) out.push({ step: p.step == null ? null : p.step + 1, kind: 'structure', message: p.message });
  return out;
}

/** Shape only: JSON, schema, ids and references. Fast, and doesn't fold anything. */
export function validateFile(file: string): CheckReport {
  const { spec, problem } = loadSpec(file);
  if (!spec) return { file, ok: false, steps: 0, problems: [problem!] };
  const problems = structureProblems(file, spec);
  return { file, id: spec.id, ok: !problems.length, steps: spec.steps?.length ?? 0, problems };
}

/** Everything: shape, then folding every step with the physical checks. Lists every problem on the step that fails. */
export function checkFile(file: string): CheckReport & { plane?: CompiledPlane } {
  const base = validateFile(file);
  const { spec } = loadSpec(file);
  if (!spec) return base;
  let plane: CompiledPlane | undefined;
  const problems = [...base.problems];
  try {
    const res = compilePlaneSoFar(spec);
    plane = res.plane;
    const err = res.error;
    const fromValidation = err && problems.some(p => p.kind === 'structure' && p.message === err.detail);
    if (err && !fromValidation) {
      const step = err.step == null ? null : err.step + 1;
      if (err.issues.length) for (const i of err.issues) problems.push({ step: i.step + 1, kind: i.kind, message: i.message });
      else problems.push({ step, kind: 'fold', message: err.detail });
    }
  } catch (e) {
    problems.push({ step: null, kind: 'fold', message: (e as Error).message });
  }
  return { ...base, ok: !problems.length, folded: plane?.steps.length ?? 0, problems, plane };
}

/** Compile, or explain why a step isn't reachable. */
export function compiled(file: string): { plane: CompiledPlane; report: CheckReport } {
  const report = checkFile(file);
  if (!report.plane) throw new Error(`${file} doesn't fold at all: ${report.problems[0]?.message ?? 'unknown problem'}`);
  return { plane: report.plane, report };
}

/** What a recipe can point at when writing step `step` (1-based). Defaults to the next step to write. */
export function refsReport(file: string, step?: number): RefsReport & { sheet: { width: number; height: number } } {
  const { plane, report } = compiled(file);
  const n = step ?? plane.steps.length + 1;
  if (n > plane.steps.length + 1) {
    const why = report.problems.find(p => p.step != null)?.message ?? '';
    throw new Error(`Step ${n} can't be reached: only ${plane.steps.length} step(s) fold. ${why}`.trim());
  }
  if (n < 1) throw new Error('Steps count from 1.');
  return { ...refsAt(plane, n - 1), sheet: { width: plane.width, height: plane.height } };
}

/** The paper after step `step` (1-based). Defaults to the last step that folds. */
export function describeReport(file: string, step?: number): StateReport {
  const { plane } = compiled(file);
  const n = step ?? plane.steps.length;
  if (n < 1 || n > plane.steps.length) throw new Error(`Step ${n} isn't available: ${plane.steps.length} step(s) fold.`);
  return describeAfter(plane, n - 1);
}

export interface Comparison {
  a: { file: string; name: string; steps: number; measures: FinishedMeasures };
  b: { file: string; name: string; steps: number; measures: FinishedMeasures };
  /** b relative to a, per measure: (b - a) / a. */
  difference: Record<keyof FinishedMeasures, number>;
  /** True when every measure is within `tolerance` of the reference. */
  close: boolean;
  tolerance: number;
}

/** Compare two finished planes; the first is the reference. */
export function compareFiles(fileA: string, fileB: string, tolerance = 0.1): Comparison {
  const side = (file: string) => {
    const { plane, report } = compiled(file);
    if (!report.ok) throw new Error(`${file} doesn't fold cleanly yet: ${report.problems[0].message}`);
    const measures = measureFinished(plane);
    if (!measures) throw new Error(`${file} doesn't end in a flight pose, so there's no finished plane to measure.`);
    return { file, name: plane.spec.name, steps: plane.steps.length, measures };
  };
  const a = side(fileA), b = side(fileB);
  const keys = Object.keys(a.measures) as (keyof FinishedMeasures)[];
  const difference = Object.fromEntries(keys.map(k => [k, a.measures[k] ? Math.round(((b.measures[k] - a.measures[k]) / a.measures[k]) * 1000) / 1000 : 0])) as Comparison['difference'];
  return { a, b, difference, close: keys.every(k => Math.abs(difference[k]) <= tolerance), tolerance };
}
