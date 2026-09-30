import { describe, expect, it } from 'vitest';
import { groupResources } from '../../src/core/resources.js';
import type { Endpoint } from '../../src/types.js';

/** A minimal endpoint, keyed by `METHOD /path`. */
function endpoint(id: string, category: Endpoint['category'] = 'data-fetching'): Endpoint {
  const [method, ...rest] = id.split(' ');
  return {
    id,
    method: method!,
    urlPattern: rest.join(' '),
    origins: ['https://example.com'],
    category,
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
  };
}

describe('groupResources', () => {
  it('groups the paths of a collection under its root', () => {
    const resources = groupResources([
      endpoint('GET /api/orders'),
      endpoint('GET /api/orders/{id}'),
      endpoint('GET /api/orders/{id}/items'),
      endpoint('GET /api/products'),
    ]);

    expect(resources.map((r) => r.path)).toEqual(['/api/orders', '/api/products']);
    expect(resources[0]!.paths.map((p) => p.path)).toEqual([
      '/api/orders',
      '/api/orders/{id}',
      '/api/orders/{id}/items',
    ]);
  });

  it('collects every verb observed on one path, uppercased and deduped', () => {
    const [orders] = groupResources([
      endpoint('GET /api/orders'),
      endpoint('POST /api/orders', 'mutations'),
      endpoint('get /api/orders'),
    ]);

    // Without an item path this is not a CRUD resource, so nothing is "missing".
    expect(orders!.paths).toEqual([
      { path: '/api/orders', methods: ['GET', 'POST'], missingMethods: [] },
    ]);
  });

  it('reports the conventional verbs a CRUD resource is missing', () => {
    const [orders] = groupResources([
      endpoint('GET /api/orders'),
      endpoint('GET /api/orders/{id}'),
    ]);

    const byPath = Object.fromEntries(orders!.paths.map((p) => [p.path, p.missingMethods]));
    // A collection is expected to list and create; an item to be read and changed.
    expect(byPath['/api/orders']).toEqual(['POST']);
    expect(byPath['/api/orders/{id}']).toEqual(['PUT', 'PATCH', 'DELETE']);
  });

  it('does not demand verbs from a resource that is not CRUD', () => {
    const [login] = groupResources([endpoint('POST /api/login', 'authentication')]);

    expect(login!.paths).toEqual([{ path: '/api/login', methods: ['POST'], missingMethods: [] }]);
  });

  it('keeps the categories seen in a resource', () => {
    const [orders] = groupResources([
      endpoint('GET /api/orders'),
      endpoint('POST /api/orders', 'mutations'),
      endpoint('GET /api/orders/{id}'),
    ]);

    expect(orders!.categories).toEqual(['data-fetching', 'mutations']);
  });

  it('treats a path that starts with a parameter as its own resource', () => {
    const resources = groupResources([endpoint('GET /{id}')]);
    expect(resources[0]!.path).toBe('/{id}');
  });
});
