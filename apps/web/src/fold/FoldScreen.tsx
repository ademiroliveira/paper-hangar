import { Button, Label, Slider } from '@heroui/react';
import { useEffect, useRef, useState } from 'react';
import type { CompiledPlane } from '@paper-hangar/crease';
import { FoldCanvas } from './FoldCanvas';
import { usePlayer, reduceMotion } from './usePlayer';

const HINT_KEY = 'paper-hangar:hint-seen';
const readHintSeen = () => { try { return localStorage.getItem(HINT_KEY) === '1'; } catch { return false; } };

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={dir === 'left' ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6'} />
    </svg>
  );
}
function PlayIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" /></svg>;
}

export function FoldScreen({ plane }: { plane: CompiledPlane }) {
  const player = usePlayer();
  const { step: k, t } = player.s;
  const steps = plane.steps, last = steps.length - 1, st = steps[k];
  const complete = t >= 0.999, finished = k === last && complete;
  const [title, text] = finished ? [plane.done.title, plane.done.text] : [st.title, st.text];

  const [hintSeen, setHintSeen] = useState(readHintSeen);
  const hideHint = () => {
    if (hintSeen) return;
    setHintSeen(true);
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* private mode */ }
  };
  useEffect(() => { if (player.s.foldedByHand || k > 0) hideHint(); }); // eslint-disable-line react-hooks/exhaustive-deps

  // A small "pop" on Next when a fold completes: motion that answers the person's action.
  const [pop, setPop] = useState(0);
  const wasComplete = useRef(complete);
  useEffect(() => {
    if (complete && !wasComplete.current && !reduceMotion) setPop(p => p + 1);
    wasComplete.current = complete;
  }, [complete]);

  const goTo = (i: number, at = 0) => { wasComplete.current = at >= 0.999; player.goTo(i, at); };
  const next = () => {
    if (finished) goTo(0);
    else if (k < last) goTo(k + 1);
    else player.animateTo(1, 1600);
  };
  const back = () => {
    if (k === 0) player.animateTo(0, 600);
    else goTo(k - 1, 1);
  };
  const play = () => {
    hideHint();
    if (player.s.t >= 0.999) player.s.t = 0;
    player.animateTo(1, 1700 * (1 - player.s.t) + 300);
  };

  return (
    <div className="fold-layout">
      <nav className="flex items-center gap-2 px-3 pt-2 [grid-area:bar] wide:px-6 wide:pt-5">
        <Button variant="ghost" size="sm" onPress={() => { window.location.hash = '#/'; }} aria-label="Back to the hangar">
          <Chevron dir="left" /> Hangar
        </Button>
        <span className="truncate text-sm text-muted">{plane.spec.name}</span>
      </nav>

      <header className="px-5 pb-1 pt-2 [grid-area:head] wide:px-7 wide:pt-4">
        <div className="grid grid-cols-[auto_1fr] items-start gap-3.5">
          <div className="min-w-[1.1ch] font-display text-[64px] font-extrabold leading-[.82] tracking-tight text-accent tabular-nums" aria-hidden="true">
            {k + 1}
            <small className="mt-1.5 block text-[15px] font-semibold leading-none tracking-normal text-muted">of {steps.length}</small>
          </div>
          <div key={title} className="copy-swap" aria-live="polite">
            <h1 className="mb-1.5 mt-0.5 font-display text-2xl font-extrabold leading-tight tracking-tight">{title}</h1>
            <p className="min-h-[2.9em] max-w-[40ch] text-base leading-snug text-muted">{text}</p>
          </div>
        </div>
        <div className="mt-3 flex gap-1.5 wide:hidden" role="group" aria-label="Steps">
          {steps.map((s, i) => (
            <button
              key={i}
              type="button"
              className="flex h-[26px] flex-1 items-center"
              aria-label={`Step ${i + 1}: ${s.title}`}
              aria-current={i === k ? 'step' : undefined}
              onClick={() => goTo(i)}
            >
              <i
                className={`block w-full rounded-full ${i === k ? 'h-[7px]' : 'h-[5px]'}`}
                style={{ background: `linear-gradient(90deg, var(--accent) 0 ${i < k ? 100 : i === k ? t * 100 : 0}%, var(--color-mat-line) 0 100%)` }}
              />
            </button>
          ))}
        </div>
      </header>

      <ol className="hidden overflow-auto px-4 py-1 [grid-area:list] wide:block" aria-label="Steps">
        {steps.map((s, i) => {
          const done = i < k || (i === k && complete);
          return (
            <li key={i}>
              <button
                type="button"
                onClick={() => goTo(i)}
                aria-current={i === k ? 'step' : undefined}
                className={`grid w-full grid-cols-[34px_1fr] items-center gap-3 rounded-xl px-2.5 py-2 text-left text-base transition-colors hover:bg-[var(--default)] ${i === k ? 'bg-[var(--default)] font-bold text-foreground' : 'text-muted'}`}
              >
                <span
                  className={`grid size-[30px] place-items-center rounded-full border-2 font-display text-[15px] font-extrabold ${
                    i === k ? 'border-accent bg-accent text-accent-foreground' : done ? 'border-[var(--color-mat-line)] bg-[var(--color-mat-line)] text-foreground' : 'border-[var(--color-mat-line)]'
                  }`}
                >
                  {i + 1}
                </span>
                <span>{s.title}</span>
              </button>
            </li>
          );
        })}
      </ol>

      <main className="relative min-h-0 select-none [grid-area:stage] wide:border-r wide:border-[var(--separator)]">
        <FoldCanvas plane={plane} player={player} step={k} />
        <div
          className={`pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 whitespace-nowrap rounded-full bg-[rgb(12_30_25/0.78)] px-4 py-2 text-[15px] backdrop-blur transition-opacity duration-300 ${hintSeen ? 'opacity-0' : 'opacity-100'}`}
        >
          Drag the paper along the <b className="text-accent">orange arrow</b>
        </div>
      </main>

      <footer className="grid gap-2.5 px-5 pb-[calc(16px+env(safe-area-inset-bottom))] pt-1.5 [grid-area:controls] wide:px-7 wide:pb-[calc(24px+env(safe-area-inset-bottom))]">
        <Slider
          className="gap-2"
          minValue={0}
          maxValue={1}
          step={0.001}
          formatOptions={{ style: 'percent', maximumFractionDigits: 0 }}
          value={t}
          onChange={v => { player.stop(); player.setT(Array.isArray(v) ? v[0] : v); }}
        >
          <Label className="text-sm font-normal text-muted">Fold</Label>
          <Slider.Output className="text-sm text-muted" />
          <Slider.Track>
            <Slider.Fill />
            <Slider.Thumb />
          </Slider.Track>
        </Slider>
        <div className="grid grid-cols-[auto_auto_1fr] gap-2.5">
          <Button variant="tertiary" size="lg" onPress={back} isDisabled={k === 0 && t <= 0.001}>
            <Chevron dir="left" /> Back
          </Button>
          <Button variant="tertiary" size="lg" onPress={play}>
            <PlayIcon /> Show me
          </Button>
          <Button key={pop} variant={complete ? 'primary' : 'tertiary'} size="lg" onPress={next} className={pop ? 'next-pop' : undefined}>
            {finished ? 'Start over' : 'Next step'}
          </Button>
        </div>
      </footer>
    </div>
  );
}
