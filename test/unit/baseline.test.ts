import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BASELINE_DIR,
  BASELINE_FILENAME,
  defaultBaselinePath,
  findBaseline,
  isLatestBaseline,
  resolveBaselinePath,
  writeBaseline,
} from '../../src/cli/baseline.js';
import type { ReconReport } from '../../src/types.js';

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'api-recon-baseline-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A minimal report — the baseline file is the report JSON verbatim. */
function report(seedUrl: string): ReconReport {
  return {
    schemaVersion: 1,
    meta: {
      seedUrl,
      startedAt: '2026-09-01T00:00:00.000Z',
      durationMs: 10,
      pagesVisited: 1,
      apiReconVersion: '0.3.9',
      engine: 'chromium',
    },
    technologies: [],
    endpoints: [],
    pages: [],
    webSockets: [],
    safety: {
      robotsRespected: true,
      robotsSkippedPaths: [],
      rateLimitMs: 0,
      maxBodyBytes: 1024,
      allowLocal: true,
      redact: true,
    },
  };
}

describe('isLatestBaseline', () => {
  it('recognizes the sentinel, case- and whitespace-insensitively', () => {
    expect(isLatestBaseline('latest')).toBe(true);
    expect(isLatestBaseline('  LATEST ')).toBe(true);
  });

  it('treats a path or any other value as a path', () => {
    expect(isLatestBaseline('./baseline/report.json')).toBe(false);
    expect(isLatestBaseline('latest.json')).toBe(false);
    expect(isLatestBaseline(undefined)).toBe(false);
    expect(isLatestBaseline(42)).toBe(false);
  });
});

describe('defaultBaselinePath', () => {
  it('names one canonical file under the working directory', () => {
    expect(defaultBaselinePath(root)).toBe(join(root, BASELINE_DIR, BASELINE_FILENAME));
  });
});

describe('findBaseline', () => {
  it('returns null when no baseline exists anywhere', async () => {
    await mkdir(join(root, 'empty', 'nested'), { recursive: true });
    expect(await findBaseline(join(root, 'empty', 'nested'))).toBeNull();
  });

  it('finds a baseline committed above the working directory', async () => {
    const file = join(root, 'repo', BASELINE_DIR, BASELINE_FILENAME);
    await mkdir(join(root, 'repo', 'packages', 'web'), { recursive: true });
    await mkdir(join(root, 'repo', BASELINE_DIR), { recursive: true });
    await writeFile(file, '{}', 'utf8');

    expect(await findBaseline(join(root, 'repo', 'packages', 'web'))).toBe(file);
  });

  it('prefers the nearest of several baselines', async () => {
    const near = join(root, 'repo', 'packages', BASELINE_DIR, BASELINE_FILENAME);
    await mkdir(join(root, 'repo', 'packages', BASELINE_DIR), { recursive: true });
    await writeFile(near, '{}', 'utf8');

    expect(await findBaseline(join(root, 'repo', 'packages'))).toBe(near);
  });

  it('ignores a directory named like the baseline file', async () => {
    const dir = join(root, 'decoy', BASELINE_DIR);
    await mkdir(dir, { recursive: true });
    await mkdir(join(dir, BASELINE_FILENAME), { recursive: true });

    expect(await findBaseline(join(root, 'decoy'))).toBeNull();
  });
});

describe('resolveBaselinePath', () => {
  it('reuses an existing baseline so a re-run updates it in place', async () => {
    const file = join(root, 'existing', BASELINE_DIR, BASELINE_FILENAME);
    await mkdir(join(root, 'existing', BASELINE_DIR), { recursive: true });
    await writeFile(file, '{}', 'utf8');

    expect(await resolveBaselinePath(join(root, 'existing'))).toBe(file);
  });

  it('falls back to the default path when nothing exists yet', async () => {
    await mkdir(join(root, 'fresh'), { recursive: true });
    expect(await resolveBaselinePath(join(root, 'fresh'))).toBe(
      defaultBaselinePath(join(root, 'fresh')),
    );
  });
});

describe('writeBaseline', () => {
  it('creates the directory and writes the report as readable JSON', async () => {
    const target = join(root, 'written', BASELINE_DIR, BASELINE_FILENAME);

    const written = await writeBaseline(report('https://example.com'), target);

    expect(written).toBe(target);
    const parsed = JSON.parse(await readFile(target, 'utf8')) as ReconReport;
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.meta.seedUrl).toBe('https://example.com');
  });
});
