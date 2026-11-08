import { Button, Card } from '@heroui/react';
import { useMemo } from 'react';
import { projectStep, type CompiledPlane } from '@paper-hangar/crease';
import { Diagram } from './Diagram';
import type { HangarEntry } from './planes';

const matGrid = {
  backgroundColor: 'var(--color-mat)',
  backgroundImage:
    'linear-gradient(var(--color-mat-line) 1px, transparent 1px), linear-gradient(90deg, var(--color-mat-line) 1px, transparent 1px)',
  backgroundSize: '12px 12px',
};

function StepCard({ plane, index }: { plane: CompiledPlane; index: number }) {
  const st = plane.steps[index];
  // Table steps are drawn before the fold, with its fold line and arrow. The flight pose is drawn
  // part-way, standing up with the wings still closed, so it differs from the finished plane.
  const projection = useMemo(
    () => (st.view === 'flight' ? { ...projectStep(plane, index, 0.55), creases: [], arrows: [] } : projectStep(plane, index, 0)),
    [plane, index, st.view],
  );
  return (
    <Card className="h-full overflow-hidden p-0">
      <div className="aspect-[4/3] overflow-hidden p-4" style={matGrid}>
        <Diagram projection={projection} highlight label={`Step ${index + 1}: ${st.title}`} className="h-full w-full" />
      </div>
      <Card.Header className="grid grid-cols-[auto_1fr] gap-x-3 px-4 py-3">
        <span className="row-span-2 font-display text-4xl font-extrabold leading-none text-accent tabular-nums">{index + 1}</span>
        <Card.Title className="font-display text-lg font-extrabold leading-tight">{st.title}</Card.Title>
        {st.text && <Card.Description className="text-[15px] text-muted">{st.text}</Card.Description>}
      </Card.Header>
    </Card>
  );
}

function DoneCard({ plane }: { plane: CompiledPlane }) {
  const projection = useMemo(() => projectStep(plane, plane.steps.length - 1, 1), [plane]);
  return (
    <Card className="h-full overflow-hidden p-0">
      <div className="aspect-[4/3] overflow-hidden p-4" style={matGrid}>
        <Diagram projection={{ ...projection, creases: [], arrows: [] }} label={`The finished ${plane.spec.name}`} className="h-full w-full" />
      </div>
      <Card.Header className="px-4 py-3">
        <Card.Title className="font-display text-lg font-extrabold">{plane.done.title}</Card.Title>
        <Card.Description className="text-[15px] text-muted">{plane.done.text}</Card.Description>
      </Card.Header>
    </Card>
  );
}

/** Every step of a plane as a diagram, drawn from the recipe. Also shows where a broken recipe stops. */
export function StepsSheet({ entry }: { entry: HangarEntry }) {
  const plane = entry.plane ?? entry.partial;
  const name = plane?.spec.name ?? entry.file;
  return (
    <main className="mx-auto max-w-5xl px-5 pb-16 pt-[calc(env(safe-area-inset-top)+16px)]">
      <nav className="mb-4 flex gap-2">
        <Button variant="ghost" size="sm" onPress={() => { window.location.hash = '#/'; }}>Hangar</Button>
        {entry.plane && (
          <Button variant="ghost" size="sm" onPress={() => { window.location.hash = `#/plane/${entry.id}`; }}>Fold it in 3D</Button>
        )}
      </nav>
      <header className="mb-6">
        <h1 className="font-display text-4xl font-extrabold tracking-tight">{name}</h1>
        <p className="mt-2 max-w-[52ch] text-base text-muted">
          {plane ? (entry.plane ? `All ${plane.steps.length} steps.` : `The first ${plane.steps.length} steps.`) : ''} Dashed orange lines are folds; arrows show which way the paper moves. The paper that moves is tinted.
        </p>
      </header>
      {entry.error && (
        <div role="alert" className="mb-6 rounded-xl border border-[var(--danger)] bg-[var(--danger-soft)] p-4 text-[var(--danger-soft-foreground)]">
          <p className="font-bold">This recipe stops here</p>
          <p className="mt-1">{entry.error}</p>
        </div>
      )}
      {plane && (
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {plane.steps.map((_, i) => <li key={i}><StepCard plane={plane} index={i} /></li>)}
          {entry.plane && <li><DoneCard plane={plane} /></li>}
        </ol>
      )}
    </main>
  );
}
