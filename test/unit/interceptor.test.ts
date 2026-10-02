import { describe, expect, it } from 'vitest';
import { TrafficInterceptor } from '../../src/core/interceptor.js';
import type { CapturedCall, CapturedWebSocket } from '../../src/types.js';

function interceptor(): TrafficInterceptor {
  return new TrafficInterceptor({
    redact: false,
    maxBodyBytes: 1024,
    includeThirdParty: false,
    seedUrl: 'https://example.com',
  });
}

function call(overrides: Partial<CapturedCall> = {}): CapturedCall {
  return {
    method: 'GET',
    url: 'https://example.com/api/orders',
    status: 200,
    mimeType: 'application/json',
    resourceType: 'fetch',
    requestHeaders: {},
    requestBodySample: null,
    responseHeaders: {},
    responseBodySample: '{"orders":[]}',
    responseBodyTruncated: false,
    startedAt: 0,
    durationMs: 1,
    triggeredBy: 'https://example.com/',
    ...overrides,
  };
}

function socket(overrides: Partial<CapturedWebSocket> = {}): CapturedWebSocket {
  return {
    url: 'wss://example.com/live',
    origins: ['wss://example.com'],
    triggeredBy: 'https://example.com/',
    openedAt: 0,
    closedAt: 1,
    frameCount: 1,
    sentCount: 1,
    receivedCount: 0,
    framesTruncated: false,
    frames: [
      { direction: 'sent', type: 'text', payloadSample: '{"subscribe":true}', size: 18, truncated: false, at: 0 },
    ],
    sentSchema: null,
    receivedSchema: null,
    ...overrides,
  };
}

describe('TrafficInterceptor.restore', () => {
  it('seeds the calls and sockets captured before a checkpoint', () => {
    const traffic = interceptor();
    expect(traffic.captured).toBe(0);

    traffic.restore({ calls: [call(), call({ url: 'https://example.com/api/user' })], webSockets: [socket()] });

    expect(traffic.calls).toHaveLength(2);
    expect(traffic.webSockets).toHaveLength(1);
    expect(traffic.captured).toBe(2);
  });

  it('is a no-op without state, and tolerates a missing socket list', () => {
    const traffic = interceptor();
    traffic.restore({});
    traffic.restore({ calls: [call()] });

    expect(traffic.captured).toBe(1);
    expect(traffic.webSockets).toHaveLength(0);
  });
});
