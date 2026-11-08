import { useMemo } from 'react';
import { projectFinal, type CompiledPlane } from '@paper-hangar/crease';
import { Diagram } from './Diagram';

/** A drawing of the finished plane, generated from the recipe. No artwork to make or keep in sync. */
export function Thumbnail({ plane, className }: { plane: CompiledPlane; className?: string }) {
  const projection = useMemo(() => {
    const p = projectFinal(plane);
    return { ...p, creases: [], arrows: [] };
  }, [plane]);
  return <Diagram projection={projection} label={`The finished ${plane.spec.name}`} className={className} />;
}
