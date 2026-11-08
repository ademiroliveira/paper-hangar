import { compilePlaneSoFar, type CompiledPlane, type PlaneSpec } from '@paper-hangar/crease';

/** Every planes/*.plane.json in the repo becomes a plane in the hangar. No registration needed. */
const files = import.meta.glob<PlaneSpec>('../../../planes/*.plane.json', { eager: true, import: 'default' });

export interface HangarEntry {
  id: string;
  file: string;
  /** Present when the whole recipe folds. */
  plane?: CompiledPlane;
  /** The steps that fold, when the recipe breaks part-way (for the review page). */
  partial?: CompiledPlane;
  error?: string;
}

export const hangar: HangarEntry[] = Object.entries(files)
  .map(([path, spec]): HangarEntry => {
    const file = path.split('/').pop()!;
    const id = spec?.id ?? file.replace(/\.plane\.json$/, '');
    try {
      const { plane, error } = compilePlaneSoFar(spec);
      return error ? { id, file, partial: plane, error: error.message } : { id, file, plane };
    } catch (e) {
      return { id, file, error: (e as Error).message };
    }
  })
  .sort((a, b) => (a.plane?.spec.difficulty ?? 9) - (b.plane?.spec.difficulty ?? 9) || a.id.localeCompare(b.id));

export const findPlane = (id: string) => hangar.find(e => e.id === id);
