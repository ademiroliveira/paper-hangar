#!/usr/bin/env node
// Runs the TypeScript source directly, so there's no build step to forget.
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/cli.ts');
process.exitCode = await main(process.argv.slice(2));
