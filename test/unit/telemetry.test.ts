import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildTelemetry,
  formatTelemetry,
  resolveTelemetryPlan,
  writeTelemetryFile,
} from '../../src/core/telemetry.js';
import type { CapturedCall, Endpoint, ReconReport } from '../../src/types.js';

const SEED = 'https://example.com';

function call(overrides: Partial<CapturedCall> & { url: string }): CapturedCall {
  return {
    method: 'GET',
    mimeType: 'application/json',
    resourceType: 'fetch',
    requestHeaders: {},
    requestBodySample: null,
    responseHeaders: {},
    responseBodySample: null,
    responseBodyTruncated: false,
    status: 200,
    startedAt: 0,
    durationMs: 1,
    triggeredBy: `${SEED}/`,
    ...overrides,
  };
}

function endpoint(overrides: Partial<Endpoint> & { id: string }): Endpoint {
  const [method, ...rest] = overrides.id.split(' ');
  return {
    method: method!,
    urlPattern: rest.join(' '),
    origins: [SEED],
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
    triggeredBy: [`${SEED}/`],
    ...overrides,
  };
}

function report(endpoints: Endpoint[]): ReconReport {
  return {
    schemaVersion: 1,
    meta: {
      seedUrl: SEED,
      startedAt: '2026-09-29T00:00:00.000Z',
      durationMs: 1,
      pagesVisited: 1,
      apiReconVersion: '0.2.3',
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
      maxBodyBytes: 1048576,
      allowLocal: false,
      redact: true,
    },
  };
}

describe('buildTelemetry', () => {
  it('reports the category, heuristic, method, and JSON-ness of each endpoint', () => {
    const calls = [
      call({ url: `${SEED}/api/orders/42` }),
      call({ url: `${SEED}/api/orders`, method: 'POST' }),
      call({ url: `${SEED}/api/login`, method: 'POST', mimeType: 'application/json' }),
      call({ url: 'https://www.google-analytics.com/collect', method: 'POST', mimeType: 'image/gif' }),
      call({ url: 'https://partner.example.org/sdk/config.json' }),
    ];
    const endpoints = [
      endpoint({ id: 'GET /api/orders/{id}' }),
      endpoint({ id: 'POST /api/orders', category: 'mutations' }),
      endpoint({ id: 'POST /api/login', category: 'authentication' }),
      endpoint({ id: 'POST /collect', category: 'analytics', mimeTypes: ['image/gif'] }),
      endpoint({ id: 'GET /sdk/config.json', category: 'third-party' }),
    ];

    const payload = buildTelemetry(report(endpoints), calls);

    expect(payload.version).toBe(1);
    expect(payload.endpointCount).toBe(5);
    const byCategory = Object.fromEntries(payload.signals.map((s) => [s.category, s]));
    expect(byCategory['data-fetching']).toMatchObject({ heuristic: 'json-response', method: 'GET', json: true });
    expect(byCategory['mutations']).toMatchObject({ heuristic: 'mutation-method', method: 'POST' });
    expect(byCategory['authentication']).toMatchObject({ heuristic: 'auth-path' });
    expect(byCategory['analytics']).toMatchObject({ heuristic: 'analytics-host', json: false });
    expect(byCategory['third-party']).toMatchObject({ heuristic: 'third-party' });
  });

  it('reports a GraphQL endpoint as the graphql heuristic', () => {
    const url = `${SEED}/api/graphql`;
    const payload = buildTelemetry(
      report([
        endpoint({
          id: 'POST /api/graphql',
          category: 'graphql',
          graphql: { introspection: true, operations: [{ name: 'GetProducts', type: 'query' }] },
        }),
      ]),
      [call({ url, method: 'POST', requestBodySample: '{"query":"query GetProducts { products { id } }"}' })],
    );

    expect(payload.signals).toEqual([
      { category: 'graphql', heuristic: 'graphql', method: 'POST', json: true },
    ]);
  });

  it('never includes a host, path, query value, or method body', () => {
    const payload = buildTelemetry(
      report([endpoint({ id: 'GET /api/orders/{id}', urlPattern: '/api/orders/{id}' })]),
      [call({ url: `${SEED}/api/orders/42?token=super-secret`, requestBodySample: '{"password":"hunter2"}' })],
    );

    const serialized = JSON.stringify(payload);
    for (const leak of ['example.com', 'google-analytics', '/api/', 'orders', 'super-secret', 'hunter2', 'token']) {
      expect(serialized, `payload should not contain ${leak}`).not.toContain(leak);
    }
    // It does carry an explicit statement of the privacy boundary.
    expect(serialized).toContain('No host, path, query values, headers, or bodies');
  });

  it('sorts signals deterministically', () => {
    const payload = buildTelemetry(
      report([
        endpoint({ id: 'GET /b', category: 'uncategorized' }),
        endpoint({ id: 'GET /a', category: 'authentication' }),
        endpoint({ id: 'GET /c', category: 'authentication' }),
      ]),
      [call({ url: `${SEED}/a` }), call({ url: `${SEED}/b` }), call({ url: `${SEED}/c` })],
    );

    expect(payload.signals.map((s) => s.category)).toEqual([
      'authentication',
      'authentication',
      'uncategorized',
    ]);
  });
});

describe('resolveTelemetryPlan', () => {
  it('does nothing when telemetry is neither enabled nor previewed', () => {
    expect(resolveTelemetryPlan({})).toEqual({ build: false, write: false, print: false });
    expect(resolveTelemetryPlan({ telemetry: false, telemetryPreview: false })).toEqual({
      build: false,
      write: false,
      print: false,
    });
  });

  it('writes but does not print when telemetry is enabled', () => {
    expect(resolveTelemetryPlan({ telemetry: true })).toEqual({
      build: true,
      write: true,
      print: false,
    });
  });

  it('builds and prints but never writes when only previewing', () => {
    expect(resolveTelemetryPlan({ telemetryPreview: true })).toEqual({
      build: true,
      write: false,
      print: true,
    });
  });

  it('does all three when the file is enabled and previewed together', () => {
    expect(resolveTelemetryPlan({ telemetry: true, telemetryPreview: true })).toEqual({
      build: true,
      write: true,
      print: true,
    });
  });
});

describe('telemetry output', () => {
  it('formats the payload as two-space JSON', () => {
    const payload = buildTelemetry(
      report([endpoint({ id: 'GET /api/orders' })]),
      [call({ url: `${SEED}/api/orders` })],
    );

    const text = formatTelemetry(payload);
    expect(text).toBe(JSON.stringify(payload, null, 2));
    expect(text.split('\n')[0]).toBe('{');
    expect(text).toContain('\n  "version": 1,');
  });

  it('previews the exact bytes that would be written to disk', async () => {
    const payload = buildTelemetry(
      report([endpoint({ id: 'GET /api/orders' })]),
      [call({ url: `${SEED}/api/orders` })],
    );
    const dir = await mkdtemp(join(tmpdir(), 'api-recon-telemetry-'));

    try {
      const file = await writeTelemetryFile(payload, dir);
      // A preview prints formatTelemetry(); the file must match it exactly.
      expect(await readFile(file, 'utf8')).toBe(formatTelemetry(payload));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
