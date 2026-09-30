import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXAMPLE_REPORT_PATH,
  readJson,
  SCHEMA_PATH,
  validateReport,
} from '../../scripts/validate-report.js';
import { loadBaseline } from '../../src/core/diff.js';
import { REPORT_SCHEMA_VERSION } from '../../src/types.js';
import { SafetyError } from '../../src/utils/safety.js';

const schema = readJson(SCHEMA_PATH) as object;

/** The smallest document the schema accepts, for negative cases to mutate. */
function minimalReport(): Record<string, unknown> {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    meta: {
      seedUrl: 'https://example.com',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      pagesVisited: 1,
      apiReconVersion: '0.0.0',
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
      allowLocal: false,
      redact: true,
    },
  };
}

describe('validateReport', () => {
  it('accepts the committed example report', () => {
    const result = validateReport(readJson(EXAMPLE_REPORT_PATH), schema);

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts a minimal report', () => {
    expect(validateReport(minimalReport(), schema).valid).toBe(true);
  });

  it('rejects a report with a renamed top-level field', () => {
    const report = minimalReport();
    report['endpointList'] = report['endpoints'];
    delete report['endpoints'];

    const result = validateReport(report, schema);

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('endpoints');
  });

  it('rejects a report whose schemaVersion is not the published one', () => {
    const result = validateReport({ ...minimalReport(), schemaVersion: 2 }, schema);

    expect(result.valid).toBe(false);
    expect(result.errors.join('\n')).toContain('schemaVersion');
  });

  it('rejects a renamed endpoint field, so a rename cannot slip out unnoticed', () => {
    const report = readJson(EXAMPLE_REPORT_PATH) as {
      endpoints: Array<Record<string, unknown>>;
    };
    const endpoint = report.endpoints[0]!;
    endpoint['url'] = endpoint['urlPattern'];
    delete endpoint['urlPattern'];

    const result = validateReport(report, schema);

    expect(result.valid).toBe(false);
    const text = result.errors.join('\n');
    expect(text).toContain('urlPattern');
    expect(text).toContain('url');
  });
});

describe('loadBaseline schema version', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'api-recon-schema-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, value: unknown): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, JSON.stringify(value), 'utf8');
    return file;
  }

  it('accepts a baseline with the current schemaVersion', async () => {
    const file = await write('ok.json', minimalReport());

    await expect(loadBaseline(file)).resolves.toBeDefined();
  });

  it('rejects a baseline written for a different schema version with a clear message', async () => {
    const file = await write('future.json', { ...minimalReport(), schemaVersion: 99 });

    const failure = loadBaseline(file);
    await expect(failure).rejects.toThrow(SafetyError);
    await expect(failure).rejects.toThrow(
      new RegExp(`expected schemaVersion ${REPORT_SCHEMA_VERSION} but found schemaVersion 99`),
    );
  });

  it('rejects a report written before reports were versioned', async () => {
    const legacy = minimalReport();
    delete legacy['schemaVersion'];
    const file = await write('legacy.json', legacy);

    const failure = loadBaseline(file);
    await expect(failure).rejects.toThrow(SafetyError);
    await expect(failure).rejects.toThrow(/no schemaVersion/);
  });
});
