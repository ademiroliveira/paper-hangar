import { compilePlane, type CompiledPlane, type PlaneSpec } from '@paper-hangar/crease';

/** Every planes/*.plane.json in the repo becomes a plane in the hangar. No registration needed. */
const files = import.meta.glob<PlaneSpec>('../../../planes/*.plane.json', { eager: true, import: 'default' });

export interface HangarEntry {
  id: string;
  file: string;
  plane?: CompiledPlane;
  error?: string;
}

export const hangar: HangarEntry[] = Object.entries(files)
  .map(([path, spec]) => {
    const file = path.split('/').pop()!;
    try {
      return { id: spec.id, file, plane: compilePlane(spec) };
    } catch (e) {
      return { id: spec.id ?? file, file, error: (e as Error).message };
    }
  })
  .sort((a, b) => (a.plane?.spec.difficulty ?? 9) - (b.plane?.spec.difficulty ?? 9) || a.id.localeCompare(b.id));

export const findPlane = (id: string) => hangar.find(e => e.id === id);
