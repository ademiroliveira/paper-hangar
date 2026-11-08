import { isRef } from './refs';
import type { FoldSpec, PlaneSpec } from './types';

export interface Problem { step: number | null; message: string }

/** Cheap structural checks with plain-language messages. Geometry problems surface later, in compilePlane. */
export function validatePlane(spec: PlaneSpec): Problem[] {
  const out: Problem[] = [];
  const top = (message: string) => out.push({ step: null, message });
  if (!spec || typeof spec !== 'object') { top('A plane must be a JSON object.'); return out; }
  if (!spec.id || !/^[a-z0-9-]+$/.test(spec.id)) top('"id" must use lowercase letters, numbers and dashes, like "classic-dart".');
  if (!spec.name) top('"name" is missing.');
  if (!spec.paper) top('"paper" is missing. Use "A4", "Letter" or { "width": …, "height": … } in cm.');
  if (!Array.isArray(spec.steps) || !spec.steps.length) { top('"steps" must list at least one step.'); return out; }

  const ids = new Set<string>();
  spec.steps.forEach((s, i) => {
    const say = (message: string) => out.push({ step: i, message });
    if (!s.title) say('"title" is missing.');
    const kinds = ['fold', 'folds', 'flip', 'pose'].filter(k => (s as unknown as Record<string, unknown>)[k] !== undefined);
    if (kinds.length !== 1) { say('Each step needs exactly one of "fold", "folds", "flip" or "pose".'); return; }
    const folds: FoldSpec[] = s.folds ?? (s.fold ? [s.fold] : []);
    folds.forEach((f, k) => {
      const label = folds.length > 1 ? `Fold ${k + 1}: ` : '';
      const refs = (['bring', 'to', 'through', 'along', 'move', 'parallel'] as const).filter(key => f[key] !== undefined);
      for (const key of refs) if (!isRef(f[key]!)) say(`${label}"${f[key]}" in "${key}" isn't a reference I know. Try corner:top-left, edge:left, crease:<id>, mid:edge:top or at:0.5,1.`);
      const bringTo = f.bring !== undefined && f.to !== undefined;
      const alongMove = f.along !== undefined && f.move !== undefined;
      const parallel = f.parallel !== undefined && f.move !== undefined && typeof f.distance === 'number';
      if (!bringTo && !alongMove && !parallel) say(`${label}use "bring" + "to", "along" + "move", or "parallel" + "distance" + "move".`);
      if (f.id) {
        if (ids.has(f.id)) say(`${label}the id "${f.id}" is already used by an earlier fold.`);
        ids.add(f.id);
      }
    });
    if (s.pose) {
      if (s.pose.type !== 'flight') say('"pose.type" must be "flight".');
      for (const key of ['spine', 'keel'] as const) if (!s.pose[key] || !isRef(s.pose[key])) say(`"pose.${key}" must be a line reference, like crease:center.`);
      if (s.pose.nose !== undefined && !isRef(s.pose.nose)) say(`"pose.nose" must be a point reference, like at:0.5,1.`);
      if (!Array.isArray(s.pose.wings) || !s.pose.wings.length) say('"pose.wings" must list the ids of the wing folds.');
      else for (const w of s.pose.wings) if (!ids.has(w)) say(`"pose.wings" mentions "${w}", but no earlier fold has that id.`);
    }
  });
  return out;
}
