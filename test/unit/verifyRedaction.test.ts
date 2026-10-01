import { describe, expect, it } from 'vitest';
import { verifyRedaction } from '../../src/core/verifyRedaction.js';
import { SecretLedger } from '../../src/utils/redactionLedger.js';
import type { Endpoint, ReconReport } from '../../src/types.js';

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    id: 'GET /api/orders',
    method: 'GET',
    urlPattern: '/api/orders',
    origins: ['https://example.com'],
    category: 'data-fetching',
    count: 1,
    statusCodes: [200],
    requestHeaders: {},
    responseHeaders: {},
    requestBodySample: null,
    responseBodySample: null,
    pathParams: [],
    queryParams: [],
    requestBodySchema: null,
    responseSchema: null,
    mimeTypes: ['application/json'],
    triggeredBy: ['https://example.com/'],
    ...overrides,
  };
}

function report(overrides: Partial<ReconReport> = {}): ReconReport {
  return {
    schemaVersion: 1,
    meta: {
      seedUrl: 'https://example.com',
      startedAt: '2026-09-01T00:00:00.000Z',
      durationMs: 1000,
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
      rateLimitMs: 500,
      maxBodyBytes: 1024,
      allowLocal: false,
      redact: true,
    },
    ...overrides,
  };
}

describe('SecretLedger', () => {
  it('keeps distinct values and ignores blanks, non-strings, and short values', () => {
    const ledger = new SecretLedger();
    ledger.add('hunter2');
    ledger.add('hunter2');
    ledger.add('  spaced-secret  ');
    ledger.add('short');
    ledger.add('');
    ledger.add(null);
    ledger.add(undefined);
    expect(ledger.values().sort()).toEqual(['hunter2', 'spaced-secret']);
    expect(ledger.size).toBe(2);
  });
});

describe('verifyRedaction', () => {
  it('reports nothing for a report that holds no redacted value', () => {
    const ledger = new SecretLedger();
    ledger.add('hunter2');
    const result = verifyRedaction(
      report({ endpoints: [endpoint({ responseBodySample: '{"ok":true}' })] }),
      ledger,
    );
    expect(result.total).toBe(0);
    expect(result.paths).toEqual([]);
    expect(result.checked).toBe(1);
  });

  it('finds a redacted value that survived in a sample field', () => {
    const ledger = new SecretLedger();
    ledger.add('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig');
    const result = verifyRedaction(
      report({
        endpoints: [
          endpoint({
            responseBodySample: '{"note":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig"}',
          }),
        ],
      }),
      ledger,
    );
    expect(result.total).toBe(1);
    expect(result.paths).toEqual(['endpoints[0].responseBodySample']);
  });

  it('finds a value that survived in a field redaction never touches, like a URL', () => {
    const ledger = new SecretLedger();
    ledger.add('demo@example.com');
    const result = verifyRedaction(
      report({
        pages: [
          {
            url: 'https://example.com/reset?email=demo@example.com',
            normalizedUrl: 'https://example.com/reset?email=demo@example.com',
            depth: 0,
            title: null,
            visitedAt: 0,
          },
        ],
      }),
      ledger,
    );
    expect(result.total).toBe(2); // both `url` and `normalizedUrl`
    expect(result.paths).toContain('pages[0].url');
    expect(result.paths).toContain('pages[0].normalizedUrl');
  });

  it('caps the reported paths but still counts every hit', () => {
    const ledger = new SecretLedger();
    ledger.add('repeated-secret');
    const endpoints = Array.from({ length: 12 }, (_, i) =>
      endpoint({ id: `GET /api/${i}`, responseBodySample: `{"v":"repeated-secret"}` }),
    );
    const result = verifyRedaction(report({ endpoints }), ledger);
    expect(result.total).toBe(12);
    expect(result.paths).toHaveLength(8);
  });

  it('checks nothing when no value was ever redacted', () => {
    const result = verifyRedaction(report(), new SecretLedger());
    expect(result.checked).toBe(0);
    expect(result.total).toBe(0);
  });
});
