import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HAND_MAINTAINED_FILES,
  compareSnapshots,
  snapshotDirectory,
} from '../../scripts/check-examples.js';

describe('compareSnapshots', () => {
  it('reports nothing when the committed examples match a fresh generation', () => {
    const snapshot = { 'report.json': 'aaa', 'report.md': 'bbb' };
    expect(compareSnapshots(snapshot, { ...snapshot })).toEqual([]);
  });

  it('names a file whose bytes changed', () => {
    const problems = compareSnapshots({ 'report.json': 'old' }, { 'report.json': 'new' });
    expect(problems).toEqual(['out of date: report.json']);
  });

  it('names a generated file that was never committed', () => {
    expect(compareSnapshots({}, { 'dashboard-diff.html': 'x' })).toEqual([
      'generated but not committed: dashboard-diff.html',
    ]);
  });

  it('names a committed file that is no longer generated', () => {
    expect(compareSnapshots({ 'report.pdf': 'x' }, {})).toEqual([
      'committed but no longer generated: report.pdf',
    ]);
  });

  it('ignores hand-maintained files that generation never writes', () => {
    // examples/output/README.md is written by hand, so a fresh generation not
    // producing it is not staleness.
    expect(HAND_MAINTAINED_FILES).toContain('README.md');
    expect(compareSnapshots({ 'README.md': 'x' }, {}, HAND_MAINTAINED_FILES)).toEqual([]);
  });

  it('reports every difference at once, in a stable order', () => {
    const problems = compareSnapshots(
      { 'a.md': '1', 'b.json': '2' },
      { 'a.md': 'changed', 'c.html': '3' },
    );
    expect(problems).toEqual([
      'out of date: a.md',
      'generated but not committed: c.html',
      'committed but no longer generated: b.json',
    ]);
  });
});

describe('snapshotDirectory', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'api-recon-example-snapshot-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('hashes nested files by their relative path, with forward slashes', async () => {
    await writeFile(join(dir, 'report.json'), '{"a":1}', 'utf8');
    await mkdir(join(dir, 'nested'), { recursive: true });
    await writeFile(join(dir, 'nested', 'style.css'), 'body{}', 'utf8');

    const snapshot = await snapshotDirectory(dir);
    expect(Object.keys(snapshot).sort()).toEqual(['nested/style.css', 'report.json']);
    // The hash is stable for identical bytes.
    expect(snapshot['report.json']).toBe((await snapshotDirectory(dir))['report.json']);
  });

  it('treats a missing directory as empty', async () => {
    expect(await snapshotDirectory(join(dir, 'does-not-exist'))).toEqual({});
  });
});
