import { describe, expect, it } from 'vitest';
import {
  attributeVendor,
  findVendor,
  isTrackingHost,
  trackingVendorDomains,
  vendorByName,
} from '../../src/core/vendors.js';
import { ANALYTICS_HOSTS, analyzeCalls } from '../../src/core/analyzer.js';
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

function endpointOf(calls: CapturedCall[]): Endpoint {
  const endpoints = analyzeCalls(calls, { seedUrl: SEED });
  expect(endpoints).toHaveLength(1);
  return endpoints[0]!;
}

describe('vendor catalog', () => {
  it('matches a host by exact name or subdomain suffix', () => {
    expect(findVendor('https://api.stripe.com/v1/charges')?.name).toBe('Stripe');
    expect(findVendor('https://stripe.com/')?.name).toBe('Stripe');
    expect(findVendor('https://cdn.segment.com/analytics.js')?.name).toBe('Segment');
  });

  it('does not match a lookalike host', () => {
    // The whole point of suffix matching: a host that merely contains a vendor
    // name is not that vendor.
    expect(findVendor('https://notstripe.com/')).toBeNull();
    expect(findVendor('https://stripe.com.evil.example/')).toBeNull();
    expect(findVendor('not a url')).toBeNull();
  });

  it('flags tracking vendors but not payments or commerce', () => {
    expect(isTrackingHost('api.segment.io')).toBe(true);
    expect(isTrackingHost('errors.sentry.io')).toBe(true);
    expect(isTrackingHost('api.stripe.com')).toBe(false);
    expect(isTrackingHost('example.com')).toBe(false);
  });

  it('derives the analytics host list from the catalog', () => {
    expect(ANALYTICS_HOSTS).toEqual(trackingVendorDomains());
    expect(ANALYTICS_HOSTS).toContain('google-analytics.com');
    expect(ANALYTICS_HOSTS).not.toContain('stripe.com');
  });

  it('shares a vendor category with technology detection', () => {
    expect(vendorByName('Sentry')?.category).toBe('monitoring');
    expect(vendorByName('Segment')?.category).toBe('analytics');
    expect(vendorByName('Nope')).toBeUndefined();
  });

  it('attributes from the first matching origin and carries the payload keys', () => {
    const keys = ['event', 'userId'];
    expect(attributeVendor(['https://other.example', 'https://api.segment.io'], keys)).toEqual({
      name: 'Segment',
      category: 'analytics',
      payloadKeys: keys,
    });
    expect(attributeVendor(['https://example.com'], keys)).toBeNull();
  });
});

describe('analyzeCalls vendor attribution', () => {
  it('names a third-party payment vendor instead of the host', () => {
    const endpoint = endpointOf([
      call({
        url: 'https://api.stripe.com/v1/charges',
        method: 'POST',
        requestBodySample: '{"amount":100,"currency":"usd"}',
      }),
    ]);

    expect(endpoint.category).toBe('third-party');
    expect(endpoint.vendor).toEqual({
      name: 'Stripe',
      category: 'payments',
      payloadKeys: ['amount', 'currency'],
    });
  });

  it('attributes an analytics-host call and lists the keys it receives', () => {
    const endpoint = endpointOf([
      call({
        url: 'https://api.segment.io/v1/track?writeKey=abc',
        method: 'POST',
        requestBodySample: '{"event":"pageview","properties":{"path":"/"},"userId":"u1"}',
      }),
    ]);

    expect(endpoint.category).toBe('analytics');
    expect(endpoint.vendor?.name).toBe('Segment');
    // Query parameter names are payload too.
    expect(endpoint.vendor?.payloadKeys).toEqual(['event', 'properties', 'userId', 'writeKey']);
  });

  it('leaves an unknown host and a first-party endpoint unattributed', () => {
    const unknown = endpointOf([
      call({ url: 'https://partner.example.net/sdk/config.json', requestBodySample: '{"e":1}' }),
    ]);
    expect(unknown.category).toBe('third-party');
    expect(unknown.vendor).toBeUndefined();

    const firstParty = endpointOf([call({ url: `${SEED}/api/collect`, method: 'POST' })]);
    expect(firstParty.category).toBe('analytics');
    expect(firstParty.vendor).toBeUndefined();
  });

  it('records an empty key list when a vendor payload was not observed', () => {
    const endpoint = endpointOf([
      call({ url: 'https://api.stripe.com/v1/charges', method: 'POST', requestBodySample: null }),
    ]);

    expect(endpoint.vendor?.name).toBe('Stripe');
    expect(endpoint.vendor?.payloadKeys).toEqual([]);
  });
});