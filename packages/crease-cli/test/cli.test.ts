import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const DART = 'planes/classic-dart.plane.json', NAK = 'planes/nakamura-lock.plane.json';

async function run(...argv: string[]) {
  let out = '', err = '';
  const code = await main(argv, { out: s => { out += s + '\n'; }, err: s => { err += s + '\n'; }, cwd: repo });
  return { code, out, err, json: () => JSON.parse(out) };
}

function broken(edit: (spec: any) => void) {
  const spec = JSON.parse(readFileSync(join(repo, DART), 'utf8'));
  edit(spec);
  const dir = mkdtempSync(join(tmpdir(), 'crease-'));
  const file = join(dir, `${spec.id}.plane.json`);
  writeFileSync(file, JSON.stringify(spec));
  return file;
}

describe('crease check', () => {
  it('passes every recipe in planes/', async () => {
    const r = await run('check', DART, NAK, '--json');
    expect(r.code).toBe(0);
    expect(r.json().map((x: any) => [x.ok, x.folded, x.steps])).toEqual([[true, 8, 8], [true, 11, 11]]);
  });

  it('names the step, kind and reason when a fold fails', async () => {
    const file = broken(s => { s.steps[1].folds[0].through = undefined; });
    const r = await run('check', file, '--json');
    expect(r.code).toBe(1);
    const p = r.json().problems[0];
    expect(p).toMatchObject({ step: 2, kind: 'fold' });
    expect(p.message).toMatch(/through/);
  });

  it('reports schema and structure problems with step numbers', async () => {
    const file = broken(s => { s.steps[0].fold.bring = 'corner:middle'; });
    const r = await run('validate', file, '--json');
    expect(r.code).toBe(1);
    const kinds = r.json().problems.map((p: any) => [p.step, p.kind]);
    expect(kinds).toContainEqual([1, 'schema']);
    expect(kinds).toContainEqual([1, 'structure']);
  });

  it('flags a file named differently from its id', async () => {
    const file = broken(s => { s.id = 'renamed'; });
    const wrong = file.replace('renamed.plane.json', 'other.plane.json');
    writeFileSync(wrong, readFileSync(file));
    const r = await run('validate', wrong, '--json');
    expect(r.json().problems[0].kind).toBe('file');
  });

  it('explains bad JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crease-'));
    writeFileSync(join(dir, 'x.plane.json'), '{ "id": ');
    const r = await run('check', join(dir, 'x.plane.json'), '--json');
    expect(r.json().problems[0].kind).toBe('json');
  });
});

describe('crease refs and describe', () => {
  it('lists what the next step can point at', async () => {
    const r = await run('refs', DART, '--step', '2', '--json');
    expect(r.code).toBe(0);
    expect(r.json().usable.map((u: any) => u.ref)).toContain('crease:center');
  });

  it('defaults to the step after the last one', async () => {
    const r = await run('refs', DART, '--json');
    expect(r.json().step).toBe(9);
  });

  it('describes the finished plane by its measurements', async () => {
    const r = await run('describe', NAK, '--json');
    expect(r.json().view).toBe('flight');
    expect(r.json().measures.length).toBeCloseTo(16.1, 0);
  });

  it('refuses a step that does not exist', async () => {
    const r = await run('describe', DART, '--step', '30');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/isn't available/);
  });
});

describe('crease render, compare and previews', () => {
  it('draws one step as SVG and PNG', async () => {
    const out = mkdtempSync(join(tmpdir(), 'crease-render-'));
    const r = await run('render', DART, '--step', '3', '--out', out, '--png', '--json');
    expect(r.code).toBe(0);
    for (const f of ['step-03.svg', 'step-03.png', 'step-03-result.svg', 'step-03-result.png']) expect(existsSync(join(out, f))).toBe(true);
    expect(readFileSync(join(out, 'step-03.png')).subarray(1, 4).toString()).toBe('PNG');
  });

  it('finds a plane close to itself and far from a different design', async () => {
    expect((await run('compare', DART, DART)).code).toBe(0);
    const r = await run('compare', DART, NAK, '--json');
    expect(r.code).toBe(1);
    expect(r.json().close).toBe(false);
  });

  it('knows the committed previews are current', async () => {
    const r = await run('previews', '--check');
    expect(r.out).toMatch(/current/);
    expect(r.code).toBe(0);
  });

  it('prints help', async () => {
    expect((await run('--help')).out).toMatch(/Usage: npx crease/);
  });
});
