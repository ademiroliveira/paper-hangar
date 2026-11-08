import { Button, Card, Chip, Link } from '@heroui/react';
import { hangar, type HangarEntry } from './planes';
import { Thumbnail } from './Thumbnail';

const LEVEL = { 1: 'Easy', 2: 'Medium', 3: 'Tricky' } as const;
const REPO = 'https://github.com/ademiroliveira/paper-hangar';

const matGrid = {
  backgroundColor: 'var(--color-mat)',
  backgroundImage:
    'linear-gradient(var(--color-mat-line) 1px, transparent 1px), linear-gradient(90deg, var(--color-mat-line) 1px, transparent 1px)',
  backgroundSize: '14px 14px',
};

function PlaneCard({ entry }: { entry: HangarEntry }) {
  const plane = entry.plane!;
  const paper = typeof plane.spec.paper === 'string' ? plane.spec.paper : `${plane.width}×${plane.height} cm`;
  return (
    <Card className="h-full overflow-hidden p-0">
      <div className="aspect-[4/3] overflow-hidden p-6" style={matGrid}>
        <Thumbnail plane={plane} className="h-full w-full" />
      </div>
      <Card.Header className="px-5 pt-4">
        <Card.Title className="font-display text-2xl font-extrabold tracking-tight">{plane.spec.name}</Card.Title>
        {plane.spec.summary && <Card.Description className="text-base text-muted">{plane.spec.summary}</Card.Description>}
      </Card.Header>
      <Card.Content className="flex-none flex-row flex-wrap items-center gap-2 px-5">
        {plane.spec.difficulty && <Chip size="sm" color="accent" variant="soft">{LEVEL[plane.spec.difficulty]}</Chip>}
        <Chip size="sm">{plane.steps.length} steps</Chip>
        <Chip size="sm">{paper}</Chip>
      </Card.Content>
      <Card.Footer className="mt-auto flex-col gap-2 px-5 pb-5">
        <Button fullWidth size="lg" onPress={() => { window.location.hash = `#/plane/${entry.id}`; }}>
          Start folding
        </Button>
        <Button fullWidth variant="ghost" onPress={() => { window.location.hash = `#/plane/${entry.id}/steps`; }}>
          See all steps
        </Button>
      </Card.Footer>
    </Card>
  );
}

/** Shown while authoring: a recipe that doesn't compile says why, in plain words. */
function BrokenCard({ entry }: { entry: HangarEntry }) {
  return (
    <Card className="h-full border border-dashed border-[var(--danger)] p-5">
      <Card.Header>
        <Card.Title className="font-display text-xl font-extrabold">{entry.file}</Card.Title>
        <Card.Description className="text-muted">This recipe doesn’t fold yet.</Card.Description>
      </Card.Header>
      <Card.Content>
        <p className="rounded-lg bg-[var(--danger-soft)] p-3 text-[15px] text-[var(--danger-soft-foreground)]">{entry.error}</p>
      </Card.Content>
      {entry.partial && entry.partial.steps.length > 0 && (
        <Card.Footer className="mt-2">
          <Button variant="ghost" onPress={() => { window.location.hash = `#/plane/${entry.id}/steps`; }}>
            See the steps that work
          </Button>
        </Card.Footer>
      )}
    </Card>
  );
}

function AddCard() {
  return (
    <Card variant="transparent" className="h-full border border-dashed border-[var(--border)] p-6">
      <Card.Header>
        <Card.Title className="font-display text-2xl font-extrabold tracking-tight">Add a plane</Card.Title>
        <Card.Description className="text-base text-muted">
          Write the folds as a short recipe in <code className="text-[var(--accent-soft-foreground)]">planes/</code> and push. It shows up here with its own 3D steps and drawing.
        </Card.Description>
      </Card.Header>
      <Card.Footer className="mt-2">
        <Link href={`${REPO}#adding-a-plane`} target="_blank" rel="noreferrer" className="text-base">
          How to write a recipe
        </Link>
      </Card.Footer>
    </Card>
  );
}

export function Hangar() {
  return (
    <main className="mx-auto max-w-5xl px-5 pb-16 pt-[calc(env(safe-area-inset-top)+32px)]">
      <header className="mb-8">
        <h1 className="font-display text-5xl font-extrabold tracking-tight">Paper Hangar</h1>
        <p className="mt-3 max-w-[44ch] text-lg text-muted">Pick a plane. Fold it here in 3D, then on a real sheet of paper.</p>
      </header>
      <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {hangar.map(e => (
          <li key={e.file}>{e.plane ? <PlaneCard entry={e} /> : <BrokenCard entry={e} />}</li>
        ))}
        <li><AddCard /></li>
      </ul>
    </main>
  );
}
