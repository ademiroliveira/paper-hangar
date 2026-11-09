import { projectStep, type Projection } from './thumbnail';
import type { CompiledPlane } from './compile';

/**
 * Projections as standalone SVG text, with no DOM or React: for the command line, previews in
 * the repo, and anything else that needs a picture of a step. Same look as the app's Diagram.
 * Numbers are rounded to 2 decimals so the output is stable across machines.
 */

const FRONT = [251, 251, 247], BACK = [53, 87, 212];
const FRONT_GLOW = [255, 214, 192], BACK_GLOW = [125, 151, 255];
const MARK = '#ff6a1f', MAT = '#173a31', MAT_LINE = '#2e5d50', INK = '#fbfbf7';

const n = (v: number) => String(Math.round(v * 100) / 100 + 0);
const shade = (rgb: number[], light: number) => `rgb(${rgb.map(c => Math.round(c * (0.7 + 0.3 * light))).join(',')})`;
const fit = (s: string, max = 27) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The shapes of one projection, fitted into the box (x, y, w, h). Returns SVG elements only. */
export function projectionShapes(p: Projection, box: [number, number, number, number], opts: { highlight?: boolean; marker: string; edges?: boolean }): string {
  const [x0, y0, x1, y1] = p.bounds;
  const pad = 2;
  const sw = x1 - x0 + pad * 2, sh = y1 - y0 + pad * 2;
  const k = Math.min(box[2] / sw, box[3] / sh);
  const ox = box[0] + (box[2] - sw * k) / 2 - (x0 - pad) * k;
  const oy = box[1] + (box[3] - sh * k) / 2 - (y0 - pad) * k;
  const pt = (q: [number, number]) => `${n(ox + q[0] * k)},${n(oy + q[1] * k)}`;
  const size = Math.max(sw, sh) * k;
  const stroke = size / 260;
  const out: string[] = [];
  for (const poly of p.polygons) {
    const glow = opts.highlight && poly.moving;
    const rgb = poly.side === 'front' ? (glow ? FRONT_GLOW : FRONT) : (glow ? BACK_GLOW : BACK);
    // `edges` outlines every piece in paper colour, so paper seen edge-on (a wing from behind) still shows.
    const edge = opts.edges ? `stroke="${INK}" stroke-width="${n(stroke * 2.5)}"` : `stroke="rgba(20,40,34,0.35)" stroke-width="${n(stroke)}"`;
    out.push(`<polygon points="${poly.points.map(pt).join(' ')}" fill="${shade(rgb, poly.light)}" ${edge} stroke-linejoin="round"/>`);
  }
  for (const [a, b] of p.creases) {
    const [ax, ay] = pt(a).split(','), [bx, by] = pt(b).split(',');
    out.push(`<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${MARK}" stroke-width="${n(stroke * 2.2)}" stroke-dasharray="${n(size / 40)} ${n(size / 70)}"/>`);
  }
  for (const arrow of p.arrows) {
    out.push(`<polyline points="${arrow.map(pt).join(' ')}" fill="none" stroke="${MARK}" stroke-width="${n(stroke * 3)}" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#${opts.marker})"/>`);
  }
  return out.join('');
}

const defs = (marker: string) =>
  `<defs><marker id="${marker}" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${MARK}"/></marker>` +
  `<pattern id="mat" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="${MAT}"/><path d="M12 0H0V12" fill="none" stroke="${MAT_LINE}" stroke-width="1"/></pattern></defs>`;

/** One projection as a whole SVG document on the cutting mat. */
export function projectionSvg(p: Projection, opts: { highlight?: boolean; edges?: boolean; label?: string; width?: number; height?: number } = {}): string {
  const w = opts.width ?? 480, h = opts.height ?? 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(opts.label ?? 'Folding step')}">` +
    defs('arrow') + `<rect width="${w}" height="${h}" fill="url(#mat)"/>` +
    projectionShapes(p, [16, 16, w - 32, h - 32], { highlight: opts.highlight, edges: opts.edges, marker: 'arrow' }) + '</svg>';
}

/** How a step is drawn in the steps sheet: before the fold, with its fold line and arrow. A flight pose is drawn part-way. */
export function stepDiagram(plane: CompiledPlane, index: number): Projection {
  const st = plane.steps[index];
  return st.view === 'flight' ? { ...projectStep(plane, index, 0.55), creases: [], arrows: [] } : projectStep(plane, index, 0);
}

/** The paper right after a step, with no marks. */
export function stepResult(plane: CompiledPlane, index: number): Projection {
  return { ...projectStep(plane, index, 1), creases: [], arrows: [] };
}

/**
 * Every step on one sheet, numbered and titled, then the finished plane:
 * the same pictures as the app's steps page, for reviewing a recipe at a glance.
 */
export function stepsSheetSvg(plane: CompiledPlane, opts: { columns?: number } = {}): string {
  const cols = opts.columns ?? 4;
  const cw = 280, ch = 250, pic = 190, gap = 12, head = 56;
  const cells: { p: Projection; label: string; highlight: boolean }[] = plane.steps.map((st, i) => ({
    p: stepDiagram(plane, i), label: `${i + 1}  ${fit(st.title)}`, highlight: true,
  }));
  if (plane.steps.at(-1)?.view === 'flight') cells.push({ p: stepResult(plane, plane.steps.length - 1), label: plane.done.title, highlight: false });
  const rows = Math.ceil(cells.length / cols);
  const W = cols * cw + (cols + 1) * gap, H = head + rows * ch + (rows + 1) * gap;
  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(`${plane.spec.name}: all ${plane.steps.length} steps`)}">`,
    defs('arrow'),
    `<rect width="${W}" height="${H}" fill="#0f2621"/>`,
    `<text x="${gap}" y="38" font-family="Inter, Helvetica, Arial, sans-serif" font-size="26" font-weight="800" fill="${INK}">${esc(plane.spec.name)}</text>`,
  ];
  cells.forEach((c, i) => {
    const x = gap + (i % cols) * (cw + gap), y = head + gap + Math.floor(i / cols) * (ch + gap);
    out.push(`<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="10" fill="url(#mat)"/>`);
    out.push(projectionShapes(c.p, [x + 10, y + 10, cw - 20, pic - 10], { highlight: c.highlight, marker: 'arrow' }));
    out.push(`<text x="${x + 14}" y="${y + pic + 34}" font-family="Inter, Helvetica, Arial, sans-serif" font-size="17" font-weight="700" fill="${INK}">${esc(c.label)}</text>`);
  });
  out.push('</svg>');
  return out.join('');
}
