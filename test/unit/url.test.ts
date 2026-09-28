import { describe, expect, it } from 'vitest';
import {
  extractLinks,
  isPrivateHost,
  isSameDomain,
  looksLikeId,
  normalizeUrl,
  toUrlPattern,
} from '../../src/utils/url.js';

describe('normalizeUrl', () => {
  it('strips fragments and sorts query params', () => {
    expect(normalizeUrl('https://a.com/p?b=2&a=1#section')).toBe('https://a.com/p?a=1&b=2');
  });

  it('removes cache busters', () => {
    expect(normalizeUrl('https://a.com/p?utm_source=x&id=3')).toBe('https://a.com/p?id=3');
  });

  it('drops trailing slash except on root', () => {
    expect(normalizeUrl('https://a.com/p/')).toBe('https://a.com/p');
    expect(normalizeUrl('https://a.com/')).toBe('https://a.com/');
  });

  it('lowercases host', () => {
    expect(normalizeUrl('https://EXAMPLE.com/P')).toBe('https://example.com/P');
  });
});

describe('toUrlPattern', () => {
  it('replaces numeric ids', () => {
    expect(toUrlPattern('https://a.com/api/orders/42')).toBe('/api/orders/{id}');
  });

  it('replaces multiple id-like segments in order', () => {
    expect(
      toUrlPattern('https://a.com/api/items/9b2f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/42'),
    ).toBe('/api/items/{id}/{id2}');
  });

  it('keeps non-id segments alongside ids', () => {
    expect(toUrlPattern('https://a.com/api/items/9b2f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b/edit')).toBe(
      '/api/items/{id}/edit',
    );
  });

  it('keeps non-id segments', () => {
    expect(toUrlPattern('https://a.com/api/products?page=2')).toBe('/api/products');
  });

  it('treats long opaque segments with digits as ids', () => {
    expect(toUrlPattern('https://a.com/api/tok_1a2b3c4d5e6f7g8h9i0j')).toBe('/api/{id}');
  });

  it('keeps alpha-only words even if long', () => {
    expect(toUrlPattern('https://a.com/api/internationalization')).toBe('/api/internationalization');
  });
});

describe('looksLikeId', () => {
  it('matches numeric and hex and uuid', () => {
    expect(looksLikeId('123')).toBe(true);
    expect(looksLikeId('deadbeef1234')).toBe(true);
    expect(looksLikeId('9b2f4a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b')).toBe(true);
    expect(looksLikeId('products')).toBe(false);
    expect(looksLikeId('v2')).toBe(false);
  });
});

describe('isSameDomain', () => {
  it('treats www and apex as same', () => {
    expect(isSameDomain('https://www.a.com/x', 'https://a.com/y')).toBe(true);
  });

  it('rejects different domains', () => {
    expect(isSameDomain('https://a.com', 'https://b.com')).toBe(false);
    expect(isSameDomain('https://a.com', 'https://evil-a.com')).toBe(false);
  });
});

describe('isPrivateHost', () => {
  it('detects localhost, loopback, rfc1918 ranges', () => {
    for (const u of [
      'http://localhost:3000/x',
      'http://127.0.0.1:8080',
      'http://10.1.2.3',
      'http://192.168.1.1',
      'http://172.16.0.1',
      'http://172.31.255.255',
      'http://mysite.local',
      'http://svc.internal',
    ]) {
      expect(isPrivateHost(u), u).toBe(true);
    }
  });

  it('allows public hosts and non-private 172.x', () => {
    for (const u of ['https://example.com', 'http://172.32.0.1', 'http://172.15.0.1', 'https://app.example.co.uk']) {
      expect(isPrivateHost(u), u).toBe(false);
    }
  });
});

describe('extractLinks', () => {
  it('extracts absolute hrefs from anchors', () => {
    const html = `<html><body>
      <a href="/products">Products</a>
      <a href="https://other.com/x">Other</a>
      <a href='#anchor'>skip</a>
    </body></html>`;
    const links = extractLinks(html, 'https://a.com/');
    expect(links).toContain('https://a.com/products');
    expect(links).toContain('https://other.com/x');
    expect(links).toHaveLength(2);
  });
});
