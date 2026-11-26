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
  const tabs = new Set<string>();
  spec.steps.forEach((s, i) => {
    const say = (message: string) => out.push({ step: i, message });
    if (!s.title) say('"title" is missing.');
    const kinds = ['fold', 'folds', 'flip', 'cut', 'pose'].filter(k => (s as unknown as Record<string, unknown>)[k] !== undefined);
    if (kinds.length !== 1) { say('Each step needs exactly one of "fold", "folds", "flip", "cut" or "pose".'); return; }
    if (s.cut) {
      if (!Array.isArray(s.cut.slits) || !s.cut.slits.length) say('"cut.slits" must list at least one slit: ["<from point>", "<to point>"].');
      else for (const sl of s.cut.slits) {
        if (!Array.isArray(sl) || sl.length !== 2) { say('Each slit is two points: ["<from>", "<to>"].'); continue; }
        for (const r of sl) if (!isRef(r)) say(`"${r}" in a slit isn't a reference I know. Try corner:top-left, mid:edge:top or at:0.5,1.`);
      }
      if (s.cut.tab !== undefined) {
        if (!/^[a-z0-9-]+$/.test(s.cut.tab)) say('"cut.tab" must use lowercase letters, numbers and dashes, like "elevator".');
        else if (ids.has(s.cut.tab)) say(`"cut.tab" "${s.cut.tab}" is already used by an earlier fold or tab.`);
        else ids.add(s.cut.tab);
        if (Array.isArray(s.cut.slits) && s.cut.slits.length !== 2) say('A tab sits between exactly two slits.');
        tabs.add(s.cut.tab);
      }
    }
    const folds: FoldSpec[] = s.folds ?? (s.fold ? [s.fold] : []);
    folds.forEach((f, k) => {
      const label = folds.length > 1 ? `Fold ${k + 1}: ` : '';
      const refs = (['bring', 'to', 'through', 'along', 'move', 'parallel', 'flap', 'squash'] as const).filter(key => f[key] !== undefined);
      for (const key of refs) if (!isRef(f[key]!)) say(`${label}"${f[key]}" in "${key}" isn't a reference I know. Try corner:top-left, edge:left, crease:<id>, mid:edge:top or at:0.5,1.`);
      if (f.line !== undefined) {
        if (!Array.isArray(f.line) || f.line.length !== 2) say(`${label}"line" must be two points: ["<point>", "<point>"].`);
        else for (const r of f.line) if (!isRef(r)) say(`${label}"${r}" in "line" isn't a reference I know. Try mid:edge:top or at:0.5,1.`);
      }
      const bringTo = f.bring !== undefined && f.to !== undefined;
      const alongMove = f.along !== undefined && f.move !== undefined;
      const parallel = f.parallel !== undefined && f.move !== undefined && typeof f.distance === 'number';
      const line = f.line !== undefined && f.move !== undefined;
      const squash = f.squash !== undefined;
      if (squash) {
        if (f.to === undefined) say(`${label}a squash fold needs "to": the line or point the flap's folded edge lands on.`);
        if (f.bring !== undefined || f.along !== undefined || f.parallel !== undefined || f.line !== undefined) say(`${label}a squash fold takes "squash" (the hinge) and "to", not "bring", "along", "parallel" or "line".`);
        if (f.reverse !== undefined || f.unfold) say(`${label}a squash fold can't also be a reverse fold or be unfolded.`);
        if (folds.length > 1) say('A squash fold has to be a step of its own.');
      } else if (!bringTo && !alongMove && !parallel && !line) say(`${label}use "bring" + "to", "along" + "move", "parallel" + "distance" + "move", "line" + "move", or "squash" + "to".`);
      if (f.reverse !== undefined && f.reverse !== 'inside') say(`${label}"reverse" can only be "inside" for now.`);
      if (f.id) {
        if (ids.has(f.id)) say(`${label}the id "${f.id}" is already used by an earlier fold.`);
        ids.add(f.id);
        if (squash) {
          if (ids.has(`${f.id}-2`)) say(`${label}a squash fold also makes "${f.id}-2", which is already used by an earlier fold.`);
          ids.add(`${f.id}-2`);
        }
      }
    });
    if (s.pose) {
      if (s.pose.type !== 'flight') say('"pose.type" must be "flight".');
      for (const key of ['spine', 'keel'] as const) if (!s.pose[key] || !isRef(s.pose[key])) say(`"pose.${key}" must be a line reference, like crease:center.`);
      if (s.pose.nose !== undefined && !isRef(s.pose.nose)) say(`"pose.nose" must be a point reference, like at:0.5,1.`);
      if (!Array.isArray(s.pose.wings) || !s.pose.wings.length) say('"pose.wings" must list the ids of the wing folds.');
      else for (const w of s.pose.wings) if (!ids.has(w)) say(`"pose.wings" mentions "${w}", but no earlier fold has that id.`);
      for (const fin of s.pose.fins ?? []) if (!ids.has(fin)) say(`"pose.fins" mentions "${fin}", but no earlier fold has that id.`);
      for (const t of s.pose.tabs ?? []) if (!tabs.has(t.id)) say(`"pose.tabs" mentions "${t.id}", but no earlier cut names a tab like that.`);
    }
  });
  return out;
}
