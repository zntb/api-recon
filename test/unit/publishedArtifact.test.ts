/**
 * The pure half of the built-artifact guard.
 *
 * `scripts/check-published.ts` is what proves the real emitted package loads —
 * it imports `dist/index.js` and runs the bin, so it needs `npm run build`
 * first. These cover the decisions it makes, without a build, so a change to
 * what counts as "broken packaging" fails fast in the unit suite rather than
 * only in CI after a build.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  REQUIRED_EXPORTS,
  exportTargets,
  missingDeclarations,
  missingExportTargets,
  shebangOf,
} from '../../scripts/check-published.js';

describe('exportTargets', () => {
  it('flattens every condition the exports map nests', () => {
    // The shape package.json actually uses: a string under `import`, a nested
    // object under `types`, and a plain string subpath.
    const targets = exportTargets({
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
      './schema/report.schema.json': './schema/report.schema.json',
    });
    expect(targets).toEqual([
      './dist/index.d.ts',
      './dist/index.js',
      './schema/report.schema.json',
    ]);
  });

  it('ignores conditions that are not paths, and empty maps', () => {
    expect(exportTargets({ './x': { default: null, browser: false } })).toEqual([]);
    expect(exportTargets({})).toEqual([]);
  });
});

describe('missingExportTargets', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'api-recon-published-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reports nothing when every named target exists', async () => {
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist', 'index.js'), '', 'utf8');
    await writeFile(join(root, 'package.json'), '{}', 'utf8');

    expect(missingExportTargets(root, ['./dist/index.js', './package.json'])).toEqual([]);
  });

  it('reports a target the build did not emit', async () => {
    // The quietest packaging break: every source test still passes, and only an
    // install fails, because the map points at a file that is not there.
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist', 'index.js'), '', 'utf8');

    expect(missingExportTargets(root, ['./dist/index.js', './dist/gone.js'])).toEqual([
      './dist/gone.js',
    ]);
  });

  it('skips targets that are not relative filesystem paths', () => {
    expect(missingExportTargets(root, ['node:fs', 'https://example.com/x'])).toEqual([]);
  });
});

describe('missingDeclarations', () => {
  it('accepts a build where every module has a declaration', () => {
    expect(
      missingDeclarations([
        'index.js',
        'index.d.ts',
        'cli/index.js',
        'cli/index.d.ts',
        'cli/index.js.map',
      ]),
    ).toEqual([]);
  });

  it('reports a module TypeScript emitted no declaration for', () => {
    expect(missingDeclarations(['index.js', 'index.d.ts', 'cli/index.js'])).toEqual([
      'cli/index.js',
    ]);
  });

  it('reports every offender at once, in a stable order', () => {
    expect(missingDeclarations(['z.js', 'a.js', 'index.js', 'index.d.ts'])).toEqual(['a.js', 'z.js']);
  });

  it('does not treat a source map as a declaration', () => {
    // `x.js.map` is not a declaration, but it is also not a module needing one.
    expect(missingDeclarations(['x.js.map', 'x.js', 'x.d.ts'])).toEqual([]);
  });
});

describe('shebangOf', () => {
  it('reads the first line', () => {
    expect(shebangOf('#!/usr/bin/env node\nconsole.log(1);\n')).toBe('#!/usr/bin/env node');
  });

  it('returns an empty string for a file with no first line', () => {
    expect(shebangOf('')).toBe('');
  });
});

describe('the documented API', () => {
  it('names the exports a consumer reaches for first', () => {
    // A rename here is a breaking change; the guard is where it gets noticed.
    expect(REQUIRED_EXPORTS).toContain('scan');
    expect(REQUIRED_EXPORTS).toContain('SafetyError');
    expect(REQUIRED_EXPORTS).toContain('RuntimeError');
    expect(REQUIRED_EXPORTS).toContain('CancelledError');
    expect(REQUIRED_EXPORTS).toContain('ApiReconError');
  });
});