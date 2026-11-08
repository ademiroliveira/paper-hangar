import { lazy, Suspense, useEffect, useState } from 'react';
import { Spinner } from '@heroui/react';
import { Hangar } from './Hangar';
import { StepsSheet } from './StepsSheet';
import { findPlane } from './planes';

// The 3D player (three.js + React Three Fiber) loads only when you open a plane.
const FoldScreen = lazy(() => import('./fold/FoldScreen').then(m => ({ default: m.FoldScreen })));

/** Hash routes keep GitHub Pages happy: #/ is the hangar, #/plane/<id> folds a plane. */
function useRoute() {
  const read = () => window.location.hash.replace(/^#\/?/, '');
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  const m = route.match(/^plane\/([a-z0-9-]+)(\/steps)?$/);
  const entry = m ? findPlane(m[1]) : undefined;
  const steps = !!m?.[2];
  useEffect(() => {
    document.title = entry?.plane ? `${entry.plane.spec.name}${steps ? ' steps' : ''} · Paper Hangar` : 'Paper Hangar';
    window.scrollTo(0, 0);
  }, [entry, steps]);
  if (entry && steps) return <StepsSheet entry={entry} />;
  if (entry?.plane) {
    return (
      <Suspense fallback={<div className="grid h-dvh place-items-center"><Spinner aria-label="Loading the plane" /></div>}>
        <FoldScreen key={entry.id} plane={entry.plane} />
      </Suspense>
    );
  }
  return <Hangar />;
}
