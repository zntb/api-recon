import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/reporters/markdown.js';
import { diffReports } from '../../src/core/diff.js';
import type { Endpoint, ReconReport } from '../../src/types.js';

function report(overrides: Partial<ReconReport> = {}): ReconReport {
  return {
    schemaVersion: 1,
    meta: {
      seedUrl: 'https://example.com',
      startedAt: '2026-09-01T00:00:00.000Z',
      durationMs: 1000,
      pagesVisited: 1,
      apiReconVersion: '0.2.2',
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
      maxBodyBytes: 1048576,
      allowLocal: false,
      redact: true,
    },
    ...overrides,
  };
}

function endpoint(overrides: Partial<Endpoint> & { id: string }): Endpoint {
  const [method, ...rest] = overrides.id.split(' ');
  return {
    method: method!,
    urlPattern: rest.join(' '),
    origins: ['https://example.com'],
    category: 'data-fetching',
    count: 1,
    statusCodes: [200],
    requestHeaders: {},
    responseHeaders: {},
    requestBodySample: null,
    responseBodySample: '{"ok":true}',
    pathParams: [],
    queryParams: [],
    requestBodySchema: null,
    responseSchema: null,
    mimeTypes: ['application/json'],
    triggeredBy: ['https://example.com/'],
    ...overrides,
  };
}

describe('renderMarkdown', () => {
  it('opens with a scorecard and a contents list that links to anchors', () => {
    const md = renderMarkdown(
      report({
        endpoints: [endpoint({ id: 'GET /api/products' })],
        resources: [
          {
            path: '/api/products',
            categories: ['data-fetching'],
            paths: [{ path: '/api/products', methods: ['GET'], missingMethods: [] }],
          },
        ],
        findings: [
          {
            kind: 'pii',
            severity: 'medium',
            title: 'PII-shaped fields appear in captured samples',
            endpoints: ['GET /api/products'],
            details: ['GET /api/products — email'],
          },
        ],
      }),
    );

    expect(md).toContain('_Scorecard — 1 endpoint');
    expect(md).toContain('1 resource');
    expect(md).toContain('1 finding');
    expect(md).toContain('## Contents');
    expect(md).toContain('- [1. Overview](#1-overview)');
    expect(md).toContain('<a id="1-overview"></a>');
    expect(md).toContain('## 1. Overview');
  });

  it('renders a category as a badge', () => {
    const md = renderMarkdown(report({ endpoints: [endpoint({ id: 'GET /api/products' })] }));

    expect(md).toContain('<span class="cat-badge cat-data-fetching">data-fetching</span>');
  });

  it('warns when the baseline ran in a different engine', () => {
    const current = report({ meta: { ...report().meta, engine: 'firefox' } });
    const md = renderMarkdown(report({ diff: diffReports(report(), current) }));

    expect(md).toContain('## 9. Changes Since Baseline');
    expect(md).toContain('the baseline ran in **chromium** and this scan in **firefox**');
  });

  it('does not warn when both scans used the same engine', () => {
    const md = renderMarkdown(report({ diff: diffReports(report(), report()) }));
    expect(md).not.toContain('engine-specific');
  });

  it('lists each error status with its own body and schema', () => {
    const endpoint: Endpoint = {
      id: 'POST /api/login',
      method: 'POST',
      urlPattern: '/api/login',
      origins: ['https://example.com'],
      category: 'authentication',
      count: 2,
      statusCodes: [200, 401],
      requestHeaders: {},
      responseHeaders: {},
      requestBodySample: null,
      responseBodySample: '{"ok":true}',
      pathParams: [],
      queryParams: [],
      requestBodySchema: null,
      responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      errorResponses: [
        {
          status: 401,
          count: 1,
          bodySample: '{"error":"invalid_credentials"}',
          schema: { type: 'object', properties: { error: { type: 'string' } } },
          mimeTypes: ['application/json'],
        },
      ],
      mimeTypes: ['application/json'],
      triggeredBy: ['https://example.com/login'],
    };

    const md = renderMarkdown(report({ endpoints: [endpoint] }));

    expect(md).toContain('**Error responses**');
    expect(md).toContain('**`401`** — 1 occurrence(s), application/json');
    expect(md).toContain('invalid_credentials');
    expect(md).toContain('"error"');
    // The success shape stays separate from the failure shape.
    expect(md).toContain('**Inferred response schema**');
  });

  it('renders captured WebSocket frames as their own section', () => {
    const md = renderMarkdown(
      report({
        webSockets: [
          {
            url: 'wss://example.com/live',
            origins: ['wss://example.com'],
            triggeredBy: 'https://example.com/',
            openedAt: 0,
            closedAt: 5,
            frameCount: 1,
            sentCount: 1,
            receivedCount: 0,
            framesTruncated: false,
            frames: [
              {
                direction: 'sent',
                type: 'text',
                payloadSample: '{"subscribe":true,"token":"[REDACTED]"}',
                size: 40,
                truncated: false,
                at: 1,
              },
            ],
            sentSchema: {
              type: 'object',
              properties: { subscribe: { type: 'boolean' } },
            },
            receivedSchema: null,
          },
        ],
      }),
    );

    expect(md).toContain('## 8. WebSocket Traffic');
    expect(md).toContain('wss://example.com/live');
    expect(md).toContain('[REDACTED]');
    expect(md).toContain('**Inferred sent message schema**');
    expect(md).toContain('"subscribe"');
  });

  it('explains why a schema was not inferred', () => {
    const endpoint: Endpoint = {
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
      responseSchemaReason: 'truncated',
      mimeTypes: ['application/json'],
      triggeredBy: ['https://example.com/'],
    };

    const md = renderMarkdown(report({ endpoints: [endpoint] }));
    expect(md).toContain('Response schema not inferred — body was truncated');
  });

  it('shows the fields and arguments a GraphQL operation selects', () => {
    const endpoint: Endpoint = {
      id: 'POST /graphql',
      method: 'POST',
      urlPattern: '/graphql',
      origins: ['https://example.com'],
      category: 'graphql',
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
      graphql: {
        introspection: false,
        operations: [
          { name: 'GetProducts', type: 'query', selections: ['products'], arguments: ['first'] },
        ],
      },
      mimeTypes: ['application/json'],
      triggeredBy: ['https://example.com/graphql'],
    };

    const md = renderMarkdown(report({ endpoints: [endpoint] }));
    expect(md).toContain('`GetProducts` (query) → products (args: first)');
  });

  it('rolls latency, sizes, and cache into a performance view', () => {
    const endpoint: Endpoint = {
      id: 'GET /api/report',
      method: 'GET',
      urlPattern: '/api/report',
      origins: ['https://example.com'],
      category: 'data-fetching',
      count: 3,
      statusCodes: [200],
      requestHeaders: {},
      responseHeaders: { 'cache-control': 'public, max-age=60' },
      requestBodySample: null,
      responseBodySample: '{"ok":true}',
      pathParams: [],
      queryParams: [],
      requestBodySchema: null,
      responseSchema: null,
      timing: { p50: 20, p95: 40, max: 55 },
      responseBytes: { p50: 1_024, p95: 4_096, max: 8_192 },
      cache: { control: 'public, max-age=60', etag: 'W/"1"' },
      mimeTypes: ['application/json'],
      triggeredBy: ['https://example.com/'],
    };

    const md = renderMarkdown(report({ endpoints: [endpoint] }));

    expect(md).toContain('| Timing (p50 / p95 / max) | 20ms / 40ms / 55ms |');
    expect(md).toContain('| Response size (p50 / p95 / max) | 1.0 KB / 4.0 KB / 8.0 KB |');
    expect(md).toContain('cache-control `public, max-age=60`');
    expect(md).toContain('## 11. Performance');
    expect(md).toContain('### Slowest endpoints (by p95)');
    expect(md).toContain('| GET | `/api/report` | 20ms | 40ms | 55ms | 3 |');
    expect(md).toContain('### Largest responses (by p95)');
  });

  it('closes with findings grouped by severity', () => {
    const md = renderMarkdown(
      report({
        findings: [
          {
            kind: 'unauthenticated',
            severity: 'high',
            title: 'Sensitive-looking endpoints answered without credentials',
            endpoints: ['GET /api/user'],
            details: ['GET /api/user — no Authorization or Cookie header; observed 200'],
          },
          {
            kind: 'missing-security-header',
            severity: 'low',
            title: 'Security headers not observed on any response',
            endpoints: [],
            details: ['strict-transport-security was not present on any captured response'],
          },
        ],
      }),
    );

    expect(md).toContain('## 12. Findings & Next Steps');
    expect(md).toContain('### High');
    expect(md).toContain('**Sensitive-looking endpoints answered without credentials** (1 endpoint)');
    expect(md).toContain('### Low');
    expect(md).toContain('(site-wide)');
  });

  it('renders resource coverage with the missing verbs', () => {
    const md = renderMarkdown(
      report({
        resources: [
          {
            path: '/api/orders',
            categories: ['data-fetching'],
            paths: [
              { path: '/api/orders', methods: ['GET'], missingMethods: ['POST'] },
              { path: '/api/orders/{id}', methods: ['GET'], missingMethods: ['PUT', 'PATCH', 'DELETE'] },
            ],
          },
        ],
      }),
    );

    expect(md).toContain('## 10. Resource Coverage');
    expect(md).toContain('`/api/orders/{id}`');
    expect(md).toContain('PUT, PATCH, DELETE');
  });
});
