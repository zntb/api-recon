import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SCAN_CHECKPOINT_FILENAME,
  SCAN_CHECKPOINT_VERSION,
  checkpointPath,
  parseScanCheckpoint,
  readScanCheckpoint,
  removeScanCheckpoint,
  writeScanCheckpoint,
  type ScanCheckpoint,
} from '../../src/core/checkpoint.js';
import { SafetyError } from '../../src/utils/errors.js';

function checkpoint(overrides: Partial<ScanCheckpoint> = {}): ScanCheckpoint {
  return {
    version: SCAN_CHECKPOINT_VERSION,
    seedUrl: 'https://example.com',
    engine: 'firefox',
    startedAt: 1_700_000_000_000,
    queue: [{ url: 'https://example.com/products', depth: 1 }],
    visited: ['https://example.com/'],
    seenPages: ['https://example.com/'],
    pages: [
      {
        url: 'https://example.com/',
        normalizedUrl: 'https://example.com/',
        depth: 0,
        title: 'Home',
        visitedAt: 1_700_000_000_001,
      },
    ],
    blockedByRobots: ['https://example.com/admin'],
    calls: [],
    webSockets: [],
    evidence: [{ url: 'https://example.com/', headers: {}, html: '', cookies: [], scripts: [] }],
    ...overrides,
  };
}

describe('checkpointPath', () => {
  it('puts the checkpoint beside the reports', () => {
    expect(checkpointPath('./reports')).toBe(join('./reports', SCAN_CHECKPOINT_FILENAME));
  });
});

describe('checkpoint round trip', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'api-recon-checkpoint-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a nested path and reads it back as the same shape', async () => {
    const file = checkpointPath(join(dir, 'out'));
    const original = checkpoint();
    await writeScanCheckpoint(file, original);

    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(original);
    await expect(readScanCheckpoint(file)).resolves.toEqual(original);
  });

  it('removes the checkpoint when the run finishes', async () => {
    const file = checkpointPath(dir);
    await writeScanCheckpoint(file, checkpoint());
    await removeScanCheckpoint(file);

    await expect(stat(file)).rejects.toThrow();
  });

  it('names the file when a checkpoint is missing', async () => {
    const failure = readScanCheckpoint(join(dir, 'nope.json'));
    await expect(failure).rejects.toThrow(SafetyError);
    await expect(failure).rejects.toThrow(/No checkpoint found/);
  });

  it('refuses a checkpoint that is not JSON', async () => {
    const file = checkpointPath(dir);
    await writeFile(file, '{ not json', 'utf8');
    await expect(readScanCheckpoint(file)).rejects.toThrow(/not valid JSON/);
  });
});

describe('parseScanCheckpoint', () => {
  it('accepts a checkpoint this build wrote', () => {
    const original = checkpoint();
    expect(parseScanCheckpoint(JSON.parse(JSON.stringify(original)))).toEqual(original);
  });

  it('defaults the engine when it is missing or unknown', () => {
    const fresh = JSON.parse(JSON.stringify(checkpoint({ engine: undefined as never })));
    expect(parseScanCheckpoint(fresh).engine).toBe('chromium');
    const unknown = JSON.parse(JSON.stringify(checkpoint({ engine: 'netscape' as never })));
    expect(parseScanCheckpoint(unknown).engine).toBe('chromium');
  });

  it('refuses a version it cannot read, naming both', () => {
    const future = JSON.parse(JSON.stringify(checkpoint({ version: 99 })));
    expect(() => parseScanCheckpoint(future, 'out/checkpoint.json')).toThrow(
      /version 99.*version 1/s,
    );
  });

  it('refuses a non-object and a missing list', () => {
    expect(() => parseScanCheckpoint([])).toThrow(/must be a JSON object/);
    const noQueue = JSON.parse(JSON.stringify(checkpoint()));
    delete noQueue.queue;
    expect(() => parseScanCheckpoint(noQueue)).toThrow(/missing its "queue" list/);
  });

  it('refuses a malformed queue entry', () => {
    const bad = JSON.parse(JSON.stringify(checkpoint({ queue: [{ url: 1 } as never] })));
    expect(() => parseScanCheckpoint(bad)).toThrow(/malformed queue entry/);
  });
});
