import { useMemo, useReducer } from 'react';

export const reduceMotion =
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

interface Anim { from: number; to: number; start: number; dur: number }
export interface PlayerState {
  step: number;
  /** Fold progress of the current step, 0..1. */
  t: number;
  dragging: boolean;
  /** The person has folded something by dragging the paper (used to retire the hint). */
  foldedByHand: boolean;
  anim: Anim | null;
  /** The camera has been turned or zoomed away from the step's default view. */
  viewChanged: boolean;
  /** Set by the UI, consumed by the scene. */
  resetViewRequested: boolean;
}

const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Playback state shared by the 3D scene (reads it every frame) and the React UI (re-renders on change).
 * Kept outside React state so dragging stays smooth.
 */
function createPlayer(render: () => void) {
  const s: PlayerState = { step: 0, t: 0, dragging: false, foldedByHand: false, anim: null, viewChanged: false, resetViewRequested: false };
  return {
    s,
    setT(v: number) { s.t = clamp01(v); render(); },
    goTo(step: number, t = 0) { s.step = step; s.t = t; s.anim = null; render(); },
    animateTo(to: number, ms: number) {
      if (Math.abs(to - s.t) < 1e-4) return;
      s.anim = { from: s.t, to, start: performance.now(), dur: reduceMotion ? Math.min(ms, 350) : ms };
      render();
    },
    stop() { s.anim = null; },
    tick(now: number) {
      const a = s.anim;
      if (!a) return;
      const k = Math.min(1, (now - a.start) / a.dur);
      s.t = a.from + (a.to - a.from) * ease(k);
      if (k >= 1) s.anim = null;
      render();
    },
    setDragging(d: boolean) { s.dragging = d; render(); },
    markFoldedByHand() { if (!s.foldedByHand) { s.foldedByHand = true; render(); } },
    setViewChanged(v: boolean) { if (s.viewChanged !== v) { s.viewChanged = v; render(); } },
    resetView() { s.resetViewRequested = true; },
  };
}
export type Player = ReturnType<typeof createPlayer>;

export function usePlayer(): Player {
  const [, render] = useReducer((x: number) => x + 1, 0);
  return useMemo(() => createPlayer(render), []);
}
