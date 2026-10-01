import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeFormats } from '../../src/index.js';
import { FORMAT_FILENAMES } from '../../src/reporters/json.js';
import { renderShareSummary, writeShareReport } from '../../src/reporters/share.js';
import { ALL_REPORT_FORMATS, REPORT_FORMATS, type Endpoint, type ReconReport } from '../../src/types.js';

/**
 * A distinct sentinel for every field that can hold a captured value. The
 * summary must contain none of them: this is the property `--share` exists for,
 * so the test asserts the whole set at once rather than a field at a time.
 */
const SECRETS = [
  'REQUEST_BODY_SECRET',
  'RESPONSE_BODY_SECRET',
  'REQUEST_HEADER_SECRET',
  'RESPONSE_HEADER_SECRET',
  'QUERY_VALUE_SECRET',
  'ERROR_BODY_SECRET',
  'FRAME_PAYLOAD_SECRET',
  'FINDING_DETAIL_SECRET',
  'TECH_EVIDENCE_SECRET',
  'PAGE_URL_SECRET',
  'ORIGIN_SECRET',
  'TRIGGERED_BY_SECRET',
  'ROBOTS_PATH_SECRET',
];

function endpoint(overrides: Partial<Endpoint> & { id: string }): Endpoint {
  const [method, ...rest] = overrides.id.split(' ');
  return {
    method: method!,
    urlPattern: rest.join(' '),
    origins: ['https://ORIGIN_SECRET.example'],
    category: 'data-fetching',
    count: 2,
    statusCodes: [200],
    requestHeaders: { cookie: 'REQUEST_HEADER_SECRET' },
    responseHeaders: { etag: 'RESPONSE_HEADER_SECRET' },
    requestBodySample: '{"password":"REQUEST_BODY_SECRET"}',
    responseBodySample: '{"token":"RESPONSE_BODY_SECRET"}',
    pathParams: [],
    queryParams: [{ name: 'token', sampleValues: ['QUERY_VALUE_SECRET'] }],
    requestBodySchema: null,
    responseSchema: { type: 'object', properties: { id: { type: 'integer' } } },
    mimeTypes: ['application/json'],
    triggeredBy: ['https://example.com/TRIGGERED_BY_SECRET'],
    ...overrides,
  };
}

const REPORT: ReconReport = {
  schemaVersion: 1,
  meta: {
    seedUrl: 'https://example.com/PAGE_URL_SECRET',
    startedAt: '2026-10-01T00:00:00.000Z',
    durationMs: 1234,
    pagesVisited: 2,
    apiReconVersion: '0.3.9',
    engine: 'chromium',
  },
  technologies: [{ name: 'Express', category: 'framework', evidence: 'TECH_EVIDENCE_SECRET' }],
  endpoints: [
    endpoint({
      id: 'GET /api/orders',
      pathParams: ['id'],
      errorResponses: [
        {
          status: 401,
          count: 1,
          bodySample: 'ERROR_BODY_SECRET',
          schema: { type: 'object', properties: { error: { type: 'string' } } },
          mimeTypes: ['application/json'],
        },
      ],
    }),
  ],
  pages: [
    {
      url: 'https://example.com/PAGE_URL_SECRET',
      normalizedUrl: 'https://example.com/PAGE_URL_SECRET',
      depth: 0,
      title: 'Home',
      visitedAt: 0,
    },
  ],
  webSockets: [
    {
      url: 'wss://example.com/live?token=QUERY_VALUE_SECRET',
      origins: ['wss://ORIGIN_SECRET.example'],
      triggeredBy: 'https://example.com/TRIGGERED_BY_SECRET',
      openedAt: 0,
      closedAt: 1,
      frameCount: 2,
      sentCount: 1,
      receivedCount: 1,
      framesTruncated: false,
      frames: [
        { direction: 'sent', type: 'text', payloadSample: 'FRAME_PAYLOAD_SECRET', size: 10, truncated: false, at: 0 },
      ],
      sentSchema: { type: 'object', properties: { subscribe: { type: 'boolean' } } },
      receivedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    },
  ],
  safety: {
    robotsRespected: true,
    robotsSkippedPaths: ['/admin/ROBOTS_PATH_SECRET'],
    rateLimitMs: 500,
    maxBodyBytes: 1048576,
    allowLocal: false,
    redact: true,
  },
  findings: [
    {
      kind: 'pii',
      severity: 'medium',
      title: 'PII-shaped fields appear in captured samples',
      endpoints: ['GET /api/orders'],
      details: ['GET /api/orders — FINDING_DETAIL_SECRET'],
    },
  ],
};

describe('renderShareSummary', () => {
  const summary = renderShareSummary(REPORT);

  it('keeps request patterns, categories, statuses, and schemas', () => {
    expect(summary).toContain('# API surface — example.com');
    expect(summary).toContain('| Method | Path | Category | Status | Calls |');
    expect(summary).toContain('| GET | `/api/orders` | data-fetching | 200 | 2 |');
    expect(summary).toContain('### `GET /api/orders`');
    expect(summary).toContain('"id":{"type":"integer"}');
    expect(summary).toContain('Error 401');
    expect(summary).toContain('Express (framework)');
    // The socket is named by its path, and its message schemas are kept.
    expect(summary).toContain('`/live`');
    expect(summary).toContain('"subscribe":{"type":"boolean"}');
    expect(summary).toContain('PII-shaped fields appear in captured samples');
  });

  it('never carries a body, header, sample, or other captured value', () => {
    for (const secret of SECRETS) {
      expect(summary, `the share summary leaked ${secret}`).not.toContain(secret);
    }
  });

  it('lists parameter and field names but not their sampled values', () => {
    expect(summary).toContain('Query parameters: `token`');
    expect(summary).not.toContain('QUERY_VALUE_SECRET');
  });

  it('omits finding details, which can quote a captured body', () => {
    expect(summary).toContain('PII-shaped fields appear in captured samples');
    expect(summary).toContain('GET /api/orders');
    expect(summary).not.toContain('FINDING_DETAIL_SECRET');
  });

  it('renders a schema value containing backticks without breaking the inline code', () => {
    const tricky = endpoint({
      id: 'GET /api/tricky',
      responseSchema: { type: 'string', enum: ['a`b'] },
    });
    expect(renderShareSummary({ ...REPORT, endpoints: [tricky] })).toContain('a`b');
  });
});

describe('share as a report format', () => {
  it('is opt-in — never part of the default formats', () => {
    expect(ALL_REPORT_FORMATS).toContain('share');
    expect(REPORT_FORMATS).not.toContain('share');
    expect(normalizeFormats(undefined)).not.toContain('share');
  });

  it('can be requested by name, case-insensitively', () => {
    expect(normalizeFormats(['share'])).toEqual(['share']);
    expect(normalizeFormats(['Share'])).toEqual(['share']);
    expect(normalizeFormats(['json', 'share'])).toEqual(['json', 'share']);
  });

  it('writes share.md', () => {
    expect(FORMAT_FILENAMES.share).toBe('share.md');
  });
});

describe('writeShareReport', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'api-recon-share-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a leak-free share.md into the output directory', async () => {
    const file = await writeShareReport(REPORT, join(dir, 'nested'));
    expect(file.endsWith('share.md')).toBe(true);

    const text = await readFile(file, 'utf8');
    expect(text).toContain('# API surface — example.com');
    for (const secret of SECRETS) {
      expect(text, `share.md leaked ${secret}`).not.toContain(secret);
    }
  });
});
