import { describe, expect, it } from 'vitest';
import { analyzeCalls, analyzeWebSockets } from '../../src/core/analyzer.js';
import type { CapturedCall, CapturedWebSocket, Endpoint } from '../../src/types.js';
import { REDACTED } from '../../src/utils/redact.js';

const SEED = 'https://example.com';

function call(overrides: Partial<CapturedCall> & { url: string }): CapturedCall {
  return {
    method: 'GET',
    status: 200,
    mimeType: 'application/json',
    resourceType: 'fetch',
    requestHeaders: {},
    requestBodySample: null,
    responseHeaders: {},
    responseBodySample: null,
    responseBodyTruncated: false,
    startedAt: 0,
    durationMs: 1,
    triggeredBy: `${SEED}/`,
    ...overrides,
  };
}

/** Analyze a set of calls that must collapse to exactly one endpoint. */
function endpointOf(calls: CapturedCall[]): Endpoint {
  const endpoints = analyzeCalls(calls, { seedUrl: SEED });
  expect(endpoints).toHaveLength(1);
  return endpoints[0]!;
}

describe('analyzeCalls schema merging', () => {
  it('unions the response fields observed across samples', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/orders`, responseBodySample: '{"id":1,"status":"new"}' }),
      call({
        url: `${SEED}/api/orders`,
        responseBodySample: '{"id":2,"status":"shipped","total":9.5}',
      }),
    ]);

    expect(Object.keys(endpoint.responseSchema?.properties ?? {}).sort()).toEqual([
      'id',
      'status',
      'total',
    ]);
    // `total` appeared in only one response, so it is not claimed as required.
    expect(endpoint.responseSchema?.required).toEqual(['id', 'status']);
  });

  it('unions the request fields observed across samples', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/search`, method: 'POST', requestBodySample: '{"q":"a"}' }),
      call({ url: `${SEED}/api/search`, method: 'POST', requestBodySample: '{"q":"b","page":2}' }),
    ]);

    expect(Object.keys(endpoint.requestBodySchema?.properties ?? {}).sort()).toEqual(['page', 'q']);
    expect(endpoint.requestBodySchema?.required).toEqual(['q']);
  });

  it('infers the response shape from successful responses when there are any', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/orders`, status: 500, responseBodySample: '{"error":"boom"}' }),
      call({ url: `${SEED}/api/orders`, status: 200, responseBodySample: '{"id":1}' }),
    ]);

    expect(Object.keys(endpoint.responseSchema?.properties ?? {})).toEqual(['id']);
  });

  it('falls back to every response when none succeeded', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/orders`, status: 500, responseBodySample: '{"error":"boom"}' }),
      call({ url: `${SEED}/api/orders`, status: 404, responseBodySample: '{"error":"gone"}' }),
    ]);

    expect(Object.keys(endpoint.responseSchema?.properties ?? {})).toEqual(['error']);
  });

  it('annotates a single body from its own array elements', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/user`, responseBodySample: '{"id":"u1","tags":["a","b"]}' }),
    ]);

    expect(endpoint.responseSchema).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string' },
        tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      },
      required: ['id', 'tags'],
    });
  });
});

describe('analyzeCalls error contracts', () => {
  it('records one contract per error status, with its own body and schema', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/orders`, responseBodySample: '{"orders":[]}' }),
      call({
        url: `${SEED}/api/orders`,
        status: 401,
        responseBodySample: '{"error":"unauthorized"}',
      }),
      call({
        url: `${SEED}/api/orders`,
        status: 404,
        responseBodySample: '{"error":"not_found","path":"/api/orders"}',
      }),
      call({
        url: `${SEED}/api/orders`,
        status: 401,
        responseBodySample: '{"error":"unauthorized","realm":"api"}',
      }),
    ]);

    const errors = endpoint.errorResponses ?? [];
    expect(errors.map((e) => e.status)).toEqual([401, 404]);

    const unauthorized = errors.find((e) => e.status === 401)!;
    expect(unauthorized.count).toBe(2);
    expect(unauthorized.mimeTypes).toEqual(['application/json']);
    // Bodies of one status are merged like any other sample set.
    expect(Object.keys(unauthorized.schema?.properties ?? {}).sort()).toEqual(['error', 'realm']);
    expect(unauthorized.bodySample).toContain('unauthorized');

    expect(errors.find((e) => e.status === 404)?.schema?.properties).toHaveProperty('path');
  });

  it('keeps error bodies out of the success response schema', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/orders`, responseBodySample: '{"orders":[]}' }),
      call({ url: `${SEED}/api/orders`, status: 500, responseBodySample: '{"error":"boom"}' }),
    ]);

    expect(Object.keys(endpoint.responseSchema?.properties ?? {})).toEqual(['orders']);
    expect(endpoint.statusCodes).toEqual([200, 500]);
  });

  it('omits errorResponses entirely when every sample succeeded', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/orders`, responseBodySample: '{"ok":true}' }),
    ]);

    expect(endpoint.errorResponses).toBeUndefined();
  });

  it('records a contract for an endpoint that only ever failed', () => {
    const endpoint = endpointOf([
      call({
        url: `${SEED}/api/orders`,
        status: 503,
        responseBodySample: '{"error":"unavailable"}',
      }),
    ]);

    expect(endpoint.errorResponses?.map((e) => e.status)).toEqual([503]);
    // With no successful sample, the error body stays the only shape available.
    expect(Object.keys(endpoint.responseSchema?.properties ?? {})).toEqual(['error']);
  });
});

describe('analyzeCalls schema gaps', () => {
  it('records why a response schema is absent', () => {
    const json = endpointOf([call({ url: `${SEED}/api/a`, responseBodySample: null })]);
    expect(json.responseSchemaReason).toBe('no-body');

    const html = endpointOf([
      call({ url: `${SEED}/api/b`, mimeType: 'text/html', responseBodySample: null }),
    ]);
    expect(html.responseSchemaReason).toBe('not-json');

    const image = endpointOf([
      call({ url: `${SEED}/api/c`, mimeType: 'image/png', responseBodySample: null }),
    ]);
    expect(image.responseSchemaReason).toBe('binary');

    const cut = endpointOf([
      call({ url: `${SEED}/api/d`, responseBodySample: '{"a":1', responseBodyTruncated: true }),
    ]);
    expect(cut.responseSchemaReason).toBe('truncated');
  });

  it('omits the reason when the schema was fully observed', () => {
    const endpoint = endpointOf([call({ url: `${SEED}/api/ok`, responseBodySample: '{"ok":true}' })]);
    expect(endpoint.responseSchemaReason).toBeUndefined();
  });

  it('marks a present schema as partly observed when a sample was truncated', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/orders`, responseBodySample: '{"a":1}' }),
      call({ url: `${SEED}/api/orders`, responseBodySample: '{"b":2', responseBodyTruncated: true }),
    ]);
    expect(endpoint.responseSchema).not.toBeNull();
    expect(endpoint.responseSchemaReason).toBe('truncated');
  });

  it('records request body gaps', () => {
    const missing = endpointOf([
      call({ url: `${SEED}/api/m`, method: 'POST', requestBodySample: null }),
    ]);
    expect(missing.requestBodySchemaReason).toBe('no-body');

    const notJson = endpointOf([
      call({ url: `${SEED}/api/m`, method: 'POST', requestBodySample: 'a=1&b=2' }),
    ]);
    expect(notJson.requestBodySchemaReason).toBe('not-json');
  });

  it('records a reason on an error contract', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/orders`, status: 404, mimeType: 'text/html', responseBodySample: null }),
    ]);
    expect(endpoint.errorResponses?.[0]?.schemaReason).toBe('not-json');
  });
});

describe('analyzeWebSockets schema gaps', () => {
  function socket(overrides: Partial<CapturedWebSocket> & { url: string }): CapturedWebSocket {
    return {
      origins: ['wss://example.com'],
      triggeredBy: `${SEED}/`,
      openedAt: 0,
      closedAt: 1,
      frameCount: 0,
      sentCount: 0,
      receivedCount: 0,
      framesTruncated: false,
      frames: [],
      sentSchema: null,
      receivedSchema: null,
      ...overrides,
    };
  }

  it('explains an absent direction and flags a truncated stream', () => {
    const [absent] = analyzeWebSockets([socket({ url: 'wss://example.com/a' })]);
    expect(absent!.sentSchemaReason).toBe('no-body');
    expect(absent!.receivedSchemaReason).toBe('no-body');

    const [binary] = analyzeWebSockets([
      socket({
        url: 'wss://example.com/b',
        frames: [
          { direction: 'sent', type: 'binary', payloadSample: 'AAAA', size: 3, truncated: false, at: 0 },
        ],
      }),
    ]);
    expect(binary!.sentSchemaReason).toBe('binary');

    const [cut] = analyzeWebSockets([
      socket({
        url: 'wss://example.com/c',
        receivedCount: 1,
        framesTruncated: true,
        frames: [
          { direction: 'received', type: 'text', payloadSample: '{"ok":true}', size: 11, truncated: false, at: 0 },
        ],
      }),
    ]);
    expect(cut!.receivedSchema).not.toBeNull();
    expect(cut!.receivedSchemaReason).toBe('truncated');
  });
});

describe('analyzeCalls query parameter masking', () => {
  it('masks the values of sensitive names but keeps the name and its presence', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/items?token=abc123&page=2&email=jane@example.com&q=shoes` }),
    ]);
    const byName = new Map(endpoint.queryParams.map((p) => [p.name, p.sampleValues]));

    expect([...byName.keys()].sort()).toEqual(['email', 'page', 'q', 'token']);
    expect(byName.get('page')).toEqual(['2']);
    expect(byName.get('q')).toEqual(['shoes']);
    expect(byName.get('token')).toEqual([REDACTED]);
    expect(byName.get('email')).toEqual([REDACTED]);
  });

  it('never leaks a sensitive value across several samples', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/x?token=first-secret` }),
      call({ url: `${SEED}/api/x?token=second-secret` }),
    ]);
    expect(endpoint.queryParams.find((p) => p.name === 'token')!.sampleValues).toEqual([REDACTED]);
  });

  it('keeps a sensitive parameter that carried no value, with no samples', () => {
    const endpoint = endpointOf([call({ url: `${SEED}/api/x?token=` })]);
    expect(endpoint.queryParams).toEqual([{ name: 'token', sampleValues: [] }]);
  });

  it('keeps the raw values when redaction is disabled', () => {
    const [endpoint] = analyzeCalls([call({ url: `${SEED}/api/x?token=abc123` })], {
      seedUrl: SEED,
      redact: false,
    });
    expect(endpoint!.queryParams.find((p) => p.name === 'token')!.sampleValues).toEqual(['abc123']);
  });
});

describe('analyzeCalls performance roll-up', () => {
  it('summarises latency and payload sizes, and keeps cache headers', () => {
    const endpoint = endpointOf([
      call({
        url: `${SEED}/api/report`,
        durationMs: 10,
        responseBodySample: 'ab',
        requestBodySample: 'x',
        responseHeaders: {
          'cache-control': 'public, max-age=60',
          etag: 'W/"1"',
          age: '12',
          vary: 'accept-encoding',
        },
      }),
      call({ url: `${SEED}/api/report`, durationMs: 20, responseBodySample: 'abcd', requestBodySample: 'xx' }),
      call({ url: `${SEED}/api/report`, durationMs: 30, responseBodySample: 'abc', requestBodySample: 'xxx' }),
      call({ url: `${SEED}/api/report`, durationMs: 40, responseBodySample: 'a', requestBodySample: 'xxxx' }),
    ]);

    expect(endpoint.timing).toEqual({ p50: 20, p95: 40, max: 40 });
    // Sizes are the captured bytes: 1/2/3/4 in sorted order.
    expect(endpoint.responseBytes).toEqual({ p50: 2, p95: 4, max: 4 });
    expect(endpoint.requestBytes).toEqual({ p50: 2, p95: 4, max: 4 });
    expect(endpoint.cache).toEqual({
      control: 'public, max-age=60',
      etag: 'W/"1"',
      age: 12,
      vary: 'accept-encoding',
    });
  });

  it('still records timing when no bodies were captured, and omits the rest', () => {
    const endpoint = endpointOf([call({ url: `${SEED}/api/x`, durationMs: 5 })]);

    expect(endpoint.timing).toEqual({ p50: 5, p95: 5, max: 5 });
    expect(endpoint.responseBytes).toBeUndefined();
    expect(endpoint.requestBytes).toBeUndefined();
    expect(endpoint.cache).toBeUndefined();
  });

  it('finds cache headers regardless of capture casing', () => {
    const endpoint = endpointOf([
      call({ url: `${SEED}/api/x`, responseHeaders: { 'Cache-Control': 'no-store' } }),
    ]);

    expect(endpoint.cache).toEqual({ control: 'no-store' });
  });
});
