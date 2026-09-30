import { describe, expect, it } from 'vitest';
import { collectFindings } from '../../src/core/findings.js';
import type { Endpoint, ErrorResponse, ReconReport } from '../../src/types.js';

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

function error(overrides: Partial<ErrorResponse> & { status: number }): ErrorResponse {
  return { count: 1, bodySample: null, schema: null, mimeTypes: ['application/json'], ...overrides };
}

function report(endpoints: Endpoint[]): ReconReport {
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
    endpoints,
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
  };
}

function kind(findings: ReturnType<typeof collectFindings>, name: string) {
  return findings.find((finding) => finding.kind === name);
}

describe('collectFindings unauthenticated', () => {
  it('flags a sensitive path answered without credentials', () => {
    const findings = collectFindings(report([endpoint({ id: 'GET /api/user' })]));

    const finding = kind(findings, 'unauthenticated');
    expect(finding?.severity).toBe('high');
    expect(finding?.endpoints).toEqual(['GET /api/user']);
    expect(finding?.details[0]).toContain('no Authorization or Cookie header');
  });

  it('does not flag when a credential was sent', () => {
    const withAuth = endpoint({
      id: 'GET /api/user',
      requestHeaders: { authorization: '[REDACTED]' },
    });
    expect(kind(collectFindings(report([withAuth])), 'unauthenticated')).toBeUndefined();
  });

  it('does not flag a public path or an endpoint that only failed', () => {
    const publicPath = endpoint({ id: 'GET /api/products' });
    const failed = endpoint({ id: 'GET /api/admin', statusCodes: [401] });

    expect(kind(collectFindings(report([publicPath])), 'unauthenticated')).toBeUndefined();
    expect(kind(collectFindings(report([failed])), 'unauthenticated')).toBeUndefined();
  });

  it('excludes analytics and third-party endpoints, which are expected to be anonymous', () => {
    const analytics = endpoint({ id: 'GET /api/collect', category: 'analytics' });
    expect(kind(collectFindings(report([analytics])), 'unauthenticated')).toBeUndefined();
  });
});

describe('collectFindings PII', () => {
  it('lists PII-shaped field paths from request, response, and error shapes', () => {
    const withPii = endpoint({
      id: 'GET /api/profile',
      responseSchema: {
        type: 'object',
        properties: {
          contact: { type: 'object', properties: { email: { type: 'string' }, phone: { type: 'string' } } },
          name: { type: 'string' },
        },
      },
      errorResponses: [
        error({ status: 422, schema: { type: 'object', properties: { ssn: { type: 'string' } } } }),
      ],
    });

    const finding = kind(collectFindings(report([withPii])), 'pii');
    expect(finding?.severity).toBe('medium');
    expect(finding?.endpoints).toEqual(['GET /api/profile']);
    const text = finding!.details.join(' ');
    expect(text).toContain('contact.email');
    expect(text).toContain('contact.phone');
    expect(text).toContain('ssn');
    expect(text).not.toContain('name');
  });

  it('reports nothing when no field name looks personal', () => {
    const plain = endpoint({
      id: 'GET /api/x',
      responseSchema: { type: 'object', properties: { total: { type: 'number' } } },
    });
    expect(kind(collectFindings(report([plain])), 'pii')).toBeUndefined();
  });
});

describe('collectFindings verbose errors', () => {
  it('flags an error body that leaked internals', () => {
    const leaky = endpoint({
      id: 'GET /api/x',
      errorResponses: [
        error({
          status: 500,
          bodySample: '{"error":"boom","stack":"Error: boom\\n at /app/node_modules/express/index.js"}',
        }),
      ],
    });

    const finding = kind(collectFindings(report([leaky])), 'verbose-error');
    expect(finding?.severity).toBe('medium');
    expect(finding?.details[0]).toContain('500 body exposed internals');
    expect(finding?.details[0]).toContain('node_modules');
  });

  it('leaves a clean error contract alone', () => {
    const clean = endpoint({
      id: 'GET /api/x',
      errorResponses: [error({ status: 404, bodySample: '{"error":"not_found"}' })],
    });
    expect(kind(collectFindings(report([clean])), 'verbose-error')).toBeUndefined();
  });
});

describe('collectFindings missing security headers', () => {
  it('lists the security headers no response sent', () => {
    const findings = collectFindings(
      report([endpoint({ id: 'GET /api/x', responseHeaders: { 'content-type': 'application/json' } })]),
    );

    const finding = kind(findings, 'missing-security-header');
    expect(finding?.severity).toBe('low');
    expect(finding?.endpoints).toEqual([]);
    expect(finding?.details).toContain('strict-transport-security was not present on any captured response');
  });

  it('reports nothing once every security header was seen', () => {
    const hardened = endpoint({
      id: 'GET /api/x',
      responseHeaders: {
        'strict-transport-security': 'max-age=63072000',
        'content-security-policy': "default-src 'self'",
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'permissions-policy': 'geolocation=()',
      },
    });
    expect(kind(collectFindings(report([hardened])), 'missing-security-header')).toBeUndefined();
  });

  it('reports nothing at all when there are no endpoints', () => {
    expect(collectFindings(report([]))).toEqual([]);
  });
});

describe('collectFindings inconsistent shapes', () => {
  it('flags a schema that had to fall back to a oneOf union', () => {
    const inconsistent = endpoint({
      id: 'GET /api/x',
      responseSchema: {
        oneOf: [
          { type: 'object', properties: { id: { type: 'integer' } } },
          { type: 'object', properties: { error: { type: 'string' } } },
        ],
      },
    });

    const finding = kind(collectFindings(report([inconsistent])), 'inconsistent-shape');
    expect(finding?.severity).toBe('low');
    expect(finding?.details[0]).toContain('shape varied across samples');
    expect(finding?.details[0]).toContain('(root)');
  });

  it('reports nothing for a consistent shape', () => {
    const consistent = endpoint({
      id: 'GET /api/x',
      responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });
    expect(kind(collectFindings(report([consistent])), 'inconsistent-shape')).toBeUndefined();
  });
});

describe('collectFindings ordering', () => {
  it('sorts high-severity findings before medium and low', () => {
    const findings = collectFindings(
      report([
        endpoint({ id: 'GET /api/user' }), // unauthenticated (high)
        endpoint({
          id: 'GET /api/profile',
          responseSchema: { type: 'object', properties: { email: { type: 'string' } } },
        }), // pii (medium)
      ]),
    );

    expect(findings.map((finding) => finding.severity)).toEqual(['high', 'medium', 'low']);
  });
});
