import { describe, expect, it } from 'vitest';
import { analyzeCalls } from '../../src/core/analyzer.js';
import type { CapturedCall, Endpoint } from '../../src/types.js';

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
