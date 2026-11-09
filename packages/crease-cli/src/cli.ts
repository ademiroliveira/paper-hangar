import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import { projectionSvg, projectStep, stepDiagram, stepResult, stepsSheetSvg } from '@paper-hangar/crease';
import { checkFile, compareFiles, compiled, describeReport, refsReport, validateFile, type CheckReport } from './report.ts';

const HELP = `crease: check, inspect and draw plane recipes.

Usage: npx crease <command> <file> [options]

  check <file...>             Fold every step and run the physical checks. Lists every problem.
  validate <file...>          Shape only: JSON, schema, ids and references. Doesn't fold.
  refs <file> [--step n]      What step n can point at, and where each thing is now.
                              Default: the next step to write.
  describe <file> [--step n]  The paper after step n: layers, size, which side is up, corners,
                              creases. After a flight pose: the plane's measurements.
  render <file> [--step n] [--out dir] [--png]
                              Draw the steps as SVG (and PNG with --png). Default folder:
                              .crease/renders/<id>/
  compare <reference> <file>  Measure two finished planes and compare them (10% tolerance).
  previews [--check]          Redraw planes/previews/<id>.svg for every recipe, or check they're current.

Options:
  --json      Machine-readable output.
  --step n    A step number, counting from 1.

Positions are in cm on the table: x to the right, y away from you, the same axes as the
flat sheet before anything moves.`;

export interface Io { out: (s: string) => void; err: (s: string) => void; cwd: string }
const defaultIo: Io = { out: s => process.stdout.write(s + '\n'), err: s => process.stderr.write(s + '\n'), cwd: process.cwd() };

interface Args { cmd?: string; files: string[]; json: boolean; png: boolean; check: boolean; step?: number; out?: string }

function parse(argv: string[]): Args {
  const a: Args = { files: [], json: false, png: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i];
    if (s === '--json') a.json = true;
    else if (s === '--png') a.png = true;
    else if (s === '--check') a.check = true;
    else if (s === '--step') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v)) throw new Error('--step needs a whole number, counting from 1.');
      a.step = v;
    } else if (s === '--out') a.out = argv[++i];
    else if (s === '-h' || s === '--help') a.cmd = 'help';
    else if (s.startsWith('--')) throw new Error(`Unknown option ${s}.`);
    else if (!a.cmd) a.cmd = s;
    else a.files.push(s);
  }
  return a;
}

const pt = (p?: [number, number]) => (p ? `(${p[0]}, ${p[1]})` : '');
const pct = (x: number) => `${x > 0 ? '+' : ''}${Math.round(x * 100)}%`;

function checkText(r: CheckReport): string {
  if (r.ok) return r.folded == null ? `✓ ${r.file}: the recipe is well formed (${r.steps} steps).` : `✓ ${r.file}: all ${r.steps} steps fold cleanly.`;
  const lines = [r.folded == null ? `✗ ${r.file}` : `✗ ${r.file}: ${r.folded} of ${r.steps} steps fold.`];
  for (const p of r.problems) lines.push(`  ${p.step == null ? 'recipe' : `step ${p.step}`} · ${p.kind} · ${p.message}`);
  return lines.join('\n');
}

function root(cwd: string): string {
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(join(d, 'planes')) && existsSync(join(d, 'package.json'))) return d;
    if (dirname(d) === d) throw new Error('Run this inside the paper-hangar repo: no planes/ folder found above here.');
  }
}

function png(svg: string, file: string, width?: number) {
  const r = new Resvg(svg, { fitTo: width ? { mode: 'width', value: width } : { mode: 'original' }, font: { loadSystemFonts: true, defaultFontFamily: 'Inter' } });
  writeFileSync(file, r.render().asPng());
}

export async function main(argv: string[], io: Io = defaultIo): Promise<number> {
  let a: Args;
  try { a = parse(argv); } catch (e) { io.err((e as Error).message); return 2; }
  const at = (f: string) => resolve(io.cwd, f);
  const say = (json: unknown, text: string) => io.out(a.json ? JSON.stringify(json, null, 2) : text);
  try {
    switch (a.cmd) {
      case undefined:
      case 'help':
        io.out(HELP);
        return 0;

      case 'check':
      case 'validate': {
        if (!a.files.length) throw new Error(`Which recipe? e.g. npx crease ${a.cmd} planes/classic-dart.plane.json`);
        const reports = a.files.map(f => {
          const r = a.cmd === 'check' ? checkFile(at(f)) : validateFile(at(f));
          const { plane: _p, ...rest } = r as CheckReport & { plane?: unknown };
          return { ...rest, file: f };
        });
        say(reports.length === 1 ? reports[0] : reports, reports.map(checkText).join('\n'));
        return reports.every(r => r.ok) ? 0 : 1;
      }

      case 'refs': {
        const r = refsReport(at(need(a)), a.step);
        const width = Math.max(...r.usable.map(u => u.ref.length)) + 2;
        const lines = [`What step ${r.step} can point at (positions in cm on the table):`, ''];
        for (const u of r.usable) {
          const where = u.kind === 'point' ? pt(u.at) : `${pt(u.from)} → ${pt(u.to)}`;
          lines.push(`  ${u.ref.padEnd(width)}${u.kind.padEnd(7)}${where}${u.madeIn ? `   made in step ${u.madeIn}` : ''}`);
        }
        if (r.unusable.length) {
          lines.push('', "Can't be used right now:");
          for (const u of r.unusable) lines.push(`  ${u.ref}: ${u.reason}`);
        }
        lines.push('', `Any other point: at:<x>,<y> as fractions of the flat sheet (${r.sheet.width} × ${r.sheet.height} cm), e.g. at:0.5,1 is the middle of the top edge.`);
        say(r, lines.join('\n'));
        return 0;
      }

      case 'describe': {
        const r = describeReport(at(need(a)), a.step);
        const lines = [`After step ${r.step}, "${r.title}" (${r.view} view, ${r.pieces} pieces of paper):`];
        if (r.size) lines.push(`  Size on the table: ${r.size.width} × ${r.size.depth} cm`);
        if (r.maxLayers != null) lines.push(`  Thickest point: ${r.maxLayers} layers`);
        if (r.frontUp != null) lines.push(`  Front side facing up: ${Math.round(r.frontUp * 100)}% of the paper`);
        if (r.topLayer) lines.push(`  Top layer: ${r.topLayer.side} side up, from around ${pt(r.topLayer.centerOnSheet)} on the flat sheet`);
        if (r.measures) {
          const m = r.measures;
          lines.push(`  Wingspan ${m.wingspan} cm · length ${m.length} cm · body depth ${m.bodyDepth} cm · height ${m.height} cm`);
        }
        lines.push(`  Corners now: ${Object.entries(r.corners).map(([k, v]) => `${k} ${pt(v)}`).join(', ')}`);
        lines.push(`  Creases: ${r.creases.map(c => `${c.id} (step ${c.madeIn})`).join(', ') || 'none yet'}`);
        say(r, lines.join('\n'));
        return 0;
      }

      case 'render': {
        const file = at(need(a));
        const { plane, report } = compiled(file);
        const dir = resolve(io.cwd, a.out ?? join(relative(io.cwd, root(io.cwd)), '.crease', 'renders', plane.spec.id));
        mkdirSync(dir, { recursive: true });
        const written: string[] = [];
        const put = (name: string, svg: string, width?: number) => {
          writeFileSync(join(dir, `${name}.svg`), svg);
          written.push(join(dir, `${name}.svg`));
          if (a.png) { png(svg, join(dir, `${name}.png`), width); written.push(join(dir, `${name}.png`)); }
        };
        const nn = (i: number) => String(i + 1).padStart(2, '0');
        const indices = a.step ? [a.step - 1] : plane.steps.map((_, i) => i);
        for (const i of indices) {
          if (!plane.steps[i]) throw new Error(`Step ${i + 1} isn't available: ${plane.steps.length} step(s) fold.`);
          const t = plane.steps[i].title;
          put(`step-${nn(i)}`, projectionSvg(stepDiagram(plane, i), { highlight: true, label: `Step ${i + 1}: ${t}` }));
          put(`step-${nn(i)}-result`, projectionSvg(stepResult(plane, i), { label: `After step ${i + 1}: ${t}` }));
        }
        if (!a.step) {
          put('sheet', stepsSheetSvg(plane), 1200);
          const last = plane.steps.length - 1;
          if (plane.steps[last]?.view === 'flight') {
            put('final-side', projectionSvg({ ...projectStep(plane, last, 1, { theta: Math.PI / 2, phi: Math.PI / 2 }), creases: [], arrows: [] }, { edges: true, label: 'Finished plane from the side' }));
            put('final-back', projectionSvg({ ...projectStep(plane, last, 1, { theta: 0, phi: Math.PI / 2 }), creases: [], arrows: [] }, { edges: true, label: 'Finished plane from behind' }));
            put('final-top', projectionSvg({ ...projectStep(plane, last, 1, { theta: 0, phi: 0.0001 }), creases: [], arrows: [] }, { edges: true, label: 'Finished plane from above' }));
          }
        }
        const rel = written.map(w => relative(io.cwd, w));
        const note = report.ok ? '' : `\nOnly ${plane.steps.length} of ${report.steps} steps fold, so later steps aren't drawn.`;
        say({ dir: relative(io.cwd, dir), files: rel, folded: plane.steps.length, steps: report.steps }, `Drew ${rel.length} file(s) in ${relative(io.cwd, dir) || '.'}:\n${rel.map(r => `  ${r}`).join('\n')}${note}`);
        return 0;
      }

      case 'compare': {
        if (a.files.length !== 2) throw new Error('Compare needs two recipes: npx crease compare <reference> <file>');
        const c = compareFiles(at(a.files[0]), at(a.files[1]));
        const keys = Object.keys(c.a.measures) as (keyof typeof c.a.measures)[];
        const label: Record<string, string> = { wingspan: 'Wingspan', length: 'Length', bodyDepth: 'Body depth', height: 'Height' };
        const lines = [`${'cm'.padEnd(12)}${c.a.name.padEnd(22)}${c.b.name.padEnd(22)}difference`];
        for (const k of keys) lines.push(`${label[k].padEnd(12)}${String(c.a.measures[k]).padEnd(22)}${String(c.b.measures[k]).padEnd(22)}${pct(c.difference[k])}`);
        lines.push('', c.close ? `Close: every measure is within ${c.tolerance * 100}%.` : `Not close: at least one measure differs by more than ${c.tolerance * 100}%.`);
        say(c, lines.join('\n'));
        return c.close ? 0 : 1;
      }

      case 'previews': {
        const base = root(io.cwd);
        const planes = join(base, 'planes'), out = join(planes, 'previews');
        mkdirSync(out, { recursive: true });
        const stale: string[] = [], done: string[] = [];
        for (const f of readdirSync(planes).filter(x => x.endsWith('.plane.json')).sort()) {
          const r = checkFile(join(planes, f));
          if (!r.plane || !r.ok) { stale.push(`${f} doesn't fold cleanly, so it has no preview`); continue; }
          const svg = stepsSheetSvg(r.plane);
          const target = join(out, `${r.plane.spec.id}.svg`);
          if (a.check) {
            if (!existsSync(target) || readFileSync(target, 'utf8') !== svg) stale.push(relative(io.cwd, target));
          } else { writeFileSync(target, svg); done.push(relative(io.cwd, target)); }
        }
        if (a.check) {
          say({ ok: !stale.length, stale }, stale.length ? `Out of date:\n${stale.map(s => `  ${s}`).join('\n')}\nRun: npx crease previews` : '✓ Every preview is current.');
          return stale.length ? 1 : 0;
        }
        say({ written: done, skipped: stale }, `Drew ${done.length} preview(s):\n${done.map(d => `  ${d}`).join('\n')}${stale.length ? `\nSkipped:\n${stale.map(s => `  ${s}`).join('\n')}` : ''}`);
        return 0;
      }

      default:
        io.err(`Unknown command "${a.cmd}".\n\n${HELP}`);
        return 2;
    }
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
}

function need(a: Args): string {
  if (!a.files[0]) throw new Error(`Which recipe? e.g. npx crease ${a.cmd} planes/classic-dart.plane.json`);
  return a.files[0];
}
