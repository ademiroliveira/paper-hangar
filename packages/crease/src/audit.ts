import { Vector3 } from 'three';
import type { CompiledPlane, Op, Step } from './compile';
import { GAP, faceMatrix, stepMatrices } from './compile';
import { flatToLocal, overlapsFromAbove, sharedSegments, type Face } from './geometry';

/**
 * Physical checks that hold for any real piece of paper, whatever the plane.
 * They run on every compile, so a recipe that would tear paper, push paper through paper or
 * through the table never reaches the screen: the hangar shows the problem and CI refuses to deploy.
 */
export type AuditKind = 'sheet' | 'tear' | 'pierce' | 'below-table' | 'not-flat';
export interface AuditIssue { step: number; kind: AuditKind; message: string }

const fmt = (p: [number, number]) => `(${p[0].toFixed(1)}, ${p[1].toFixed(1)}) cm on the flat sheet`;
const SAMPLES = [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1];

/** Distance in the table plane from a point to an op's axis line. */
function distToAxisXZ(op: Op, p: Vector3) {
  const ax = new Vector3(op.axis.x, 0, op.axis.z);
  if (ax.lengthSq() < 1e-12) return 0;
  ax.normalize();
  const rel = new Vector3(p.x - op.pivot.x, 0, p.z - op.pivot.z);
  return rel.sub(ax.multiplyScalar(rel.dot(ax))).length();
}

export function auditStep(plane: CompiledPlane, step: Step): AuditIssue[] {
  const issues: AuditIssue[] = [];
  const say = (kind: AuditKind, message: string) => issues.push({ step: step.index, kind, message });
  const faces = step.faces;

  // 1. The sheet stays whole: faces tile the sheet exactly once.
  const area = faces.reduce((s, f) => s + f.area(), 0);
  if (Math.abs(area - plane.width * plane.height) > 1e-3) say('sheet', 'The sheet lost or gained paper while splitting along a crease.');
  if (faces.some(f => f.area() < 1e-6)) say('sheet', 'A fold made a sliver of zero size; two creases are probably almost on top of each other.');

  // 2. No tearing: where moving paper meets paper that stays (or moves differently), that seam must be the hinge.
  const pairs: [number, number, [number, number][][]][] = [];
  for (let i = 0; i < faces.length; i++) for (let j = i + 1; j < faces.length; j++) {
    const segs = sharedSegments(faces[i], faces[j]);
    if (segs.length) pairs.push([i, j, segs]);
  }
  step.ops.forEach(op => {
    for (const [i, j, segs] of pairs) {
      if (op.moving[i] === op.moving[j]) continue;
      for (const seg of segs) for (const p of seg) {
        const w = flatToLocal(p as [number, number]).applyMatrix4(faces[i].M);
        if (distToAxisXZ(op, w) > 1e-3) {
          say('tear', `The paper would tear: a fold moves one side of a seam without the other, near ${fmt(p as [number, number])}. Check which layers this fold takes.`);
          return;
        }
      }
    }
  });

  // 3. No paper through paper: a layer that stays put can't sit on top of a layer that lifts (valley folds lift upward).
  step.ops.forEach(op => {
    if (op.kind !== 'fold') return;
    for (let i = 0; i < faces.length; i++) {
      if (!op.moving[i]) continue;
      for (let j = 0; j < faces.length; j++) {
        if (op.moving[j] || faces[j].maxY() <= faces[i].maxY() + GAP / 2) continue;
        if (overlapsFromAbove(faces[i], faces[j])) {
          say('pierce', `This fold would push paper through paper: a layer near ${fmt(faces[j].centroidFlat())} stays put on top of paper that lifts. Fold all the layers, or fold the top flap first.`);
          return;
        }
      }
    }
  });

  // 4. Nothing goes through the table at any point of the motion; 5. flat folds end flat.
  for (const t of SAMPLES) {
    const mats = stepMatrices(step, t);
    let minY = Infinity;
    faces.forEach((f, i) => f.world(faceMatrix(step, i, mats)).forEach(v => { minY = Math.min(minY, v.y); }));
    if (minY < -1e-4) {
      say('below-table', `Part of the paper would pass through the table while this step moves (at ${Math.round(t * 100)}%).`);
      break;
    }
  }
  if (step.view === 'table') {
    const mats = stepMatrices(step, 1);
    const tilted = faces.findIndex((f, i) => {
      const ys = f.world(faceMatrix(step, i, mats)).map(v => v.y);
      return Math.max(...ys) - Math.min(...ys) > 1e-4;
    });
    if (tilted >= 0) say('not-flat', `The paper doesn't lie flat after this step, near ${fmt(faces[tilted].centroidFlat())}.`);
  }
  return issues;
}

export function auditPlane(plane: CompiledPlane): AuditIssue[] {
  return plane.steps.flatMap(st => auditStep(plane, st));
}

export type { Face };
