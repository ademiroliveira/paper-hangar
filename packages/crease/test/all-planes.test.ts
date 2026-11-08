import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020';
import schema from '../plane.schema.json';
import { compilePlane, type PlaneSpec } from '../src';

/** Every recipe in planes/ must match the schema and fold without errors. This is what CI checks on each push. */
const dir = fileURLToPath(new URL('../../../planes/', import.meta.url));
const files = readdirSync(dir).filter(f => f.endsWith('.plane.json'));
const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(schema);

describe.each(files)('%s', file => {
  const spec = JSON.parse(readFileSync(dir + file, 'utf8')) as PlaneSpec;

  it('matches the schema', () => {
    validate(spec);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('has a file name that matches its id', () => {
    expect(file).toBe(`${spec.id}.plane.json`);
  });

  it('compiles, and keeps the sheet whole at every step', () => {
    const plane = compilePlane(spec);
    for (const st of plane.steps) {
      const area = st.faces.reduce((s, f) => s + f.area(), 0);
      expect(area).toBeCloseTo(plane.width * plane.height, 6);
    }
  });
});
