import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffReports, formatDiffSummary, loadBaseline } from '../../src/core/diff.js';
import { SafetyError } from '../../src/utils/safety.js';
import type {
  CapturedWebSocket,
  Endpoint,
  ErrorResponse,
  GraphQLInfo,
  JsonSchemaLike,
  ReconReport,
  WebSocketFrame,
} from '../../src/types.js';

/** An error contract with sensible defaults, for the error-diff tests. */
function errorContract(overrides: Partial<ErrorResponse> & { status: number }): ErrorResponse {
  return {
    count: 1,
    bodySample: null,
    schema: null,
    mimeTypes: ['application/json'],
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

function report(endpoints: Endpoint[], overrides: Partial<ReconReport> = {}): ReconReport {
  return {
    schemaVersion: 1,
    meta: {
      seedUrl: 'https://example.com',
      startedAt: '2026-09-01T00:00:00.000Z',
      durationMs: 1000,
      pagesVisited: 2,
      apiReconVersion: '0.1.1',
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
    ...overrides,
  };
}

function socket(overrides: Partial<CapturedWebSocket> & { url: string }): CapturedWebSocket {
  return {
    origins: ['wss://example.com'],
    triggeredBy: 'https://example.com/',
    openedAt: 0,
    closedAt: 10,
    frameCount: 1,
    sentCount: 0,
    receivedCount: 0,
    framesTruncated: false,
    frames: [],
    sentSchema: null,
    receivedSchema: null,
    ...overrides,
  };
}

function frame(direction: WebSocketFrame['direction'], payload: string): WebSocketFrame {
  return {
    direction,
    type: 'text',
    payloadSample: payload,
    size: payload.length,
    truncated: false,
    at: 0,
  };
}

const PRODUCTS_SCHEMA: JsonSchemaLike = {
  type: 'object',
  properties: {
    page: { type: 'integer' },
    products: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } },
  },
};

/** Find the single change for an id, failing loudly when it is absent. */
function changeFor(diff: ReturnType<typeof diffReports>, id: string) {
  const change = diff.changes.find((c) => c.id === id);
  expect(change, `expected a change for ${id}`).toBeDefined();
  return change!;
}

describe('diffReports', () => {
  it('reports no changes for identical scans', () => {
    const scan = report([endpoint({ id: 'GET /api/products', responseSchema: PRODUCTS_SCHEMA })]);

    const diff = diffReports(scan, scan);

    expect(diff.hasChanges).toBe(false);
    expect(diff.changes).toEqual([]);
    expect(diff.counts).toEqual({ added: 0, removed: 0, changed: 0, breaking: 0 });
  });

  it('records the engine each scan ran in', () => {
    const baseline = report([]);
    const current = report([], { meta: { ...report([]).meta, engine: 'firefox' } });

    const diff = diffReports(baseline, current);

    expect(diff.baseline.engine).toBe('chromium');
    expect(diff.current.engine).toBe('firefox');
  });

  it('records the scans it compared', () => {
    const baseline = report([], { meta: { ...report([]).meta, startedAt: '2026-01-01T00:00:00.000Z' } });

    const diff = diffReports(baseline, report([]));

    expect(diff.baseline.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(diff.current.startedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(diff.baseline.seedUrl).toBe('https://example.com');
  });

  it('treats a new endpoint as an additive, non-breaking change', () => {
    const diff = diffReports(report([]), report([endpoint({ id: 'GET /api/search' })]));

    const change = changeFor(diff, 'GET /api/search');
    expect(change.kind).toBe('added');
    expect(change.breaking).toBe(false);
    expect(diff.counts.added).toBe(1);
  });

  it('treats a missing endpoint as breaking, and says so is not proof', () => {
    const diff = diffReports(report([endpoint({ id: 'GET /api/orders' })]), report([]));

    const change = changeFor(diff, 'GET /api/orders');
    expect(change.kind).toBe('removed');
    expect(change.breaking).toBe(true);
    expect(change.details.join(' ')).toContain('not observed in this scan');
  });

  it('flags losing every 2xx response as breaking', () => {
    const baseline = report([endpoint({ id: 'GET /api/user', statusCodes: [200] })]);
    const current = report([endpoint({ id: 'GET /api/user', statusCodes: [401] })]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/user');
    expect(change.kind).toBe('changed');
    expect(change.breaking).toBe(true);
    expect(change.details.join(' ')).toContain('no longer returns 2xx');
  });

  it('does not treat an additional status code as breaking', () => {
    const baseline = report([endpoint({ id: 'GET /api/user', statusCodes: [200] })]);
    const current = report([endpoint({ id: 'GET /api/user', statusCodes: [200, 304] })]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/user');
    expect(change.breaking).toBe(false);
    expect(change.details.join(' ')).toContain('status codes 200 → 200, 304');
  });

  it('flags a removed response field as breaking, including nested paths', () => {
    const current: JsonSchemaLike = {
      type: 'object',
      properties: {
        page: { type: 'integer' },
        products: { type: 'array', items: { type: 'object', properties: {} } },
      },
    };
    const baseline = report([endpoint({ id: 'GET /api/products', responseSchema: PRODUCTS_SCHEMA })]);
    const after = report([endpoint({ id: 'GET /api/products', responseSchema: current })]);

    const change = changeFor(diffReports(baseline, after), 'GET /api/products');
    expect(change.breaking).toBe(true);
    expect(change.details).toContain('response field removed: products[].id');
  });

  it('treats an added response field as non-breaking', () => {
    const baseline = report([
      endpoint({ id: 'GET /api/products', responseSchema: { type: 'object', properties: { a: { type: 'string' } } } }),
    ]);
    const current = report([
      endpoint({
        id: 'GET /api/products',
        responseSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'integer' } } },
      }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/products');
    expect(change.breaking).toBe(false);
    expect(change.details).toContain('response field added: b');
  });

  it('flags a response field type change as breaking', () => {
    const baseline = report([
      endpoint({ id: 'GET /api/x', responseSchema: { type: 'object', properties: { n: { type: 'string' } } } }),
    ]);
    const current = report([
      endpoint({ id: 'GET /api/x', responseSchema: { type: 'object', properties: { n: { type: 'integer' } } } }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/x');
    expect(change.breaking).toBe(true);
    expect(change.details.join(' ')).toContain('type string → integer');
  });

  it('flags a narrowed enum as breaking and a new value as additive', () => {
    const schemaWith = (values: string[]): JsonSchemaLike => ({
      type: 'object',
      properties: { status: { type: 'string', enum: values } },
    });
    const baseline = report([
      endpoint({ id: 'GET /api/orders', responseSchema: schemaWith(['shipped', 'processing', 'cancelled']) }),
    ]);
    const current = report([
      endpoint({ id: 'GET /api/orders', responseSchema: schemaWith(['shipped', 'processing', 'returned']) }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/orders');
    expect(change.breaking).toBe(true);
    const text = change.details.join(' ');
    expect(text).toContain('enum values removed: "cancelled"');
    expect(text).toContain('enum values added: "returned"');
  });

  it('flags an enum inferred for a previously open field as breaking', () => {
    const baseline = report([
      endpoint({
        id: 'GET /api/orders',
        responseSchema: { type: 'object', properties: { status: { type: 'string' } } },
      }),
    ]);
    const current = report([
      endpoint({
        id: 'GET /api/orders',
        responseSchema: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['shipped', 'processing'] } },
        },
      }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/orders');
    expect(change.breaking).toBe(true);
    expect(change.details.join(' ')).toContain('enum added ("shipped", "processing")');
  });

  it('reports an enum that is no longer inferred without calling it breaking', () => {
    const baseline = report([
      endpoint({
        id: 'GET /api/orders',
        responseSchema: {
          type: 'object',
          properties: { status: { type: 'string', enum: ['shipped', 'processing'] } },
        },
      }),
    ]);
    const current = report([
      endpoint({
        id: 'GET /api/orders',
        responseSchema: { type: 'object', properties: { status: { type: 'string' } } },
      }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/orders');
    expect(change.breaking).toBe(false);
    expect(change.details.join(' ')).toContain('enum no longer inferred (was "shipped", "processing")');
  });

  it('flags a tightened numeric range as breaking', () => {
    const schemaWith = (minimum: number, maximum: number): JsonSchemaLike => ({
      type: 'object',
      properties: { price: { type: 'number', minimum, maximum } },
    });
    const baseline = report([endpoint({ id: 'GET /api/products', responseSchema: schemaWith(1, 100) })]);
    const current = report([endpoint({ id: 'GET /api/products', responseSchema: schemaWith(10, 90) })]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/products');
    expect(change.breaking).toBe(true);
    const text = change.details.join(' ');
    expect(text).toContain('minimum 1 → 10');
    expect(text).toContain('maximum 100 → 90');
  });

  it('treats a widened numeric range as non-breaking', () => {
    const schemaWith = (minimum: number, maximum: number): JsonSchemaLike => ({
      type: 'object',
      properties: { price: { type: 'number', minimum, maximum } },
    });
    const baseline = report([endpoint({ id: 'GET /api/products', responseSchema: schemaWith(10, 90) })]);
    const current = report([endpoint({ id: 'GET /api/products', responseSchema: schemaWith(1, 100) })]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/products');
    expect(change.breaking).toBe(false);
    const text = change.details.join(' ');
    expect(text).toContain('minimum 10 → 1');
    expect(text).toContain('maximum 90 → 100');
  });

  it('does not report a removed field when the current body was truncated', () => {
    const baseline = report([
      endpoint({
        id: 'GET /api/orders',
        responseSchema: {
          type: 'object',
          properties: { id: { type: 'integer' }, total: { type: 'number' } },
        },
      }),
    ]);
    const current = report([
      endpoint({
        id: 'GET /api/orders',
        responseSchema: { type: 'object', properties: { id: { type: 'integer' } } },
        responseSchemaReason: 'truncated',
      }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/orders');
    expect(change.breaking).toBe(false);
    const text = change.details.join(' ');
    expect(text).toContain('not fully observed');
    expect(text).toContain('body was truncated');
    expect(text).not.toContain('field removed');
  });

  it('says why a schema was no longer inferred when the body became a gap', () => {
    const baseline = report([
      endpoint({
        id: 'GET /api/x',
        responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      }),
    ]);
    const current = report([
      endpoint({ id: 'GET /api/x', responseSchema: null, responseSchemaReason: 'binary' }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/x');
    expect(change.breaking).toBe(false);
    expect(change.details.join(' ')).toContain('response schema no longer inferred (body is binary)');
  });

  it('flags a field removed from an error body as breaking', () => {
    const baseline = report([
      endpoint({
        id: 'POST /api/orders',
        errorResponses: [
          errorContract({
            status: 422,
            schema: {
              type: 'object',
              properties: { error: { type: 'string' }, detail: { type: 'string' } },
            },
          }),
        ],
      }),
    ]);
    const current = report([
      endpoint({
        id: 'POST /api/orders',
        errorResponses: [
          errorContract({
            status: 422,
            schema: { type: 'object', properties: { error: { type: 'string' } } },
          }),
        ],
      }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'POST /api/orders');
    expect(change.breaking).toBe(true);
    expect(change.details).toContain('error response 422 field removed: detail');
  });

  it('does not flag an endpoint that merely gained an error status', () => {
    const baseline = report([endpoint({ id: 'GET /api/x' })]);
    const current = report([
      endpoint({
        id: 'GET /api/x',
        statusCodes: [200, 404],
        errorResponses: [
          errorContract({
            status: 404,
            schema: { type: 'object', properties: { error: { type: 'string' } } },
          }),
        ],
      }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/x');
    // The status-code comparison already reports the new status, and a new
    // failure mode breaks no existing client.
    expect(change.breaking).toBe(false);
    expect(change.details.join(' ')).toContain('status codes 200 → 200, 404');
  });

  it('reports query parameter drift without calling it breaking', () => {
    const baseline = report([
      endpoint({ id: 'GET /api/products', queryParams: [{ name: 'page', sampleValues: ['1'] }] }),
    ]);
    const current = report([
      endpoint({ id: 'GET /api/products', queryParams: [{ name: 'cursor', sampleValues: ['abc'] }] }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'GET /api/products');
    expect(change.breaking).toBe(false);
    const text = change.details.join(' ');
    expect(text).toContain('new query parameters: cursor');
    expect(text).toContain('not observed this time: page');
  });

  it('reports a category change without calling it breaking', () => {
    const baseline = report([endpoint({ id: 'POST /api/x', category: 'mutations' })]);
    const current = report([endpoint({ id: 'POST /api/x', category: 'analytics' })]);

    const change = changeFor(diffReports(baseline, current), 'POST /api/x');
    expect(change.kind).toBe('changed');
    expect(change.breaking).toBe(false);
    expect(change.details).toContain('category mutations → analytics');
  });

  it('reports a new GraphQL operation as non-breaking', () => {
    const baseline = report([
      endpoint({
        id: 'POST /graphql',
        category: 'graphql',
        graphql: { introspection: false, operations: [{ name: 'GetProducts', type: 'query' }] },
      }),
    ]);
    const current = report([
      endpoint({
        id: 'POST /graphql',
        category: 'graphql',
        graphql: {
          introspection: false,
          operations: [
            { name: 'GetProducts', type: 'query' },
            { name: 'CreateOrder', type: 'mutation' },
          ],
        },
      }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'POST /graphql');
    expect(change.breaking).toBe(false);
    expect(change.details.join(' ')).toContain('new GraphQL operations: CreateOrder (mutation)');
  });

  it('flags a GraphQL operation that is no longer observed as breaking', () => {
    const baseline = report([
      endpoint({
        id: 'POST /graphql',
        category: 'graphql',
        graphql: {
          introspection: false,
          operations: [
            { name: 'GetProducts', type: 'query' },
            { name: 'DeleteProduct', type: 'mutation' },
          ],
        },
      }),
    ]);
    const current = report([
      endpoint({
        id: 'POST /graphql',
        category: 'graphql',
        graphql: { introspection: false, operations: [{ name: 'GetProducts', type: 'query' }] },
      }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'POST /graphql');
    expect(change.breaking).toBe(true);
    expect(change.details.join(' ')).toContain(
      'GraphQL operations not observed this time: DeleteProduct (mutation)',
    );
  });

  it('flags a removed GraphQL selection as breaking and an added one as additive', () => {
    const withFields = (selections: string[]): GraphQLInfo => ({
      introspection: false,
      operations: [{ name: 'GetProducts', type: 'query', selections }],
    });
    const baseline = report([
      endpoint({
        id: 'POST /graphql',
        category: 'graphql',
        graphql: withFields(['products', 'reviews']),
      }),
    ]);
    const current = report([
      endpoint({
        id: 'POST /graphql',
        category: 'graphql',
        graphql: withFields(['products', 'orders']),
      }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'POST /graphql');
    expect(change.breaking).toBe(true);
    const text = change.details.join(' ');
    expect(text).toContain('GraphQL GetProducts selection(s) removed: reviews');
    expect(text).toContain('GraphQL GetProducts selection(s) added: orders');
  });

  it('flags a removed GraphQL argument as breaking', () => {
    const withArgs = (args: string[]): GraphQLInfo => ({
      introspection: false,
      operations: [
        { name: 'CreateOrder', type: 'mutation', selections: ['createOrder'], arguments: args },
      ],
    });
    const baseline = report([
      endpoint({ id: 'POST /graphql', category: 'graphql', graphql: withArgs(['input', 'coupon']) }),
    ]);
    const current = report([
      endpoint({ id: 'POST /graphql', category: 'graphql', graphql: withArgs(['input']) }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'POST /graphql');
    expect(change.breaking).toBe(true);
    expect(change.details.join(' ')).toContain('GraphQL CreateOrder argument(s) removed: coupon');
  });

  it('reports GraphQL introspection being newly observed without calling it breaking', () => {
    const baseline = report([
      endpoint({
        id: 'POST /graphql',
        category: 'graphql',
        graphql: { introspection: false, operations: [{ name: 'GetProducts', type: 'query' }] },
      }),
    ]);
    const current = report([
      endpoint({
        id: 'POST /graphql',
        category: 'graphql',
        graphql: {
          introspection: true,
          operations: [
            { name: 'GetProducts', type: 'query' },
            { name: 'IntrospectionQuery', type: 'query' },
          ],
        },
      }),
    ]);

    const change = changeFor(diffReports(baseline, current), 'POST /graphql');
    expect(change.breaking).toBe(false);
    const text = change.details.join(' ');
    expect(text).toContain('new GraphQL operations: IntrospectionQuery (query)');
    expect(text).toContain('GraphQL introspection newly observed');
  });

  it('reports a new WebSocket connection as additive and non-breaking', () => {
    const current = report([], {
      webSockets: [
        socket({
          url: 'wss://example.com/live',
          frameCount: 1,
          sentCount: 1,
          frames: [frame('sent', '{"subscribe":true}')],
        }),
      ],
    });

    const change = changeFor(diffReports(report([]), current), 'WS wss://example.com/live');
    expect(change.kind).toBe('added');
    expect(change.breaking).toBe(false);
    expect(change.details.join(' ')).toContain('new WebSocket connection');
  });

  it('flags a WebSocket connection that is no longer observed as breaking', () => {
    const baseline = report([], { webSockets: [socket({ url: 'wss://example.com/live', frameCount: 2 })] });

    const change = changeFor(diffReports(baseline, report([])), 'WS wss://example.com/live');
    expect(change.kind).toBe('removed');
    expect(change.breaking).toBe(true);
    expect(change.details.join(' ')).toContain('not observed in this scan');
  });

  it('flags a removed WebSocket message field as breaking', () => {
    const baseline = report([], {
      webSockets: [
        socket({ url: 'wss://example.com/live', frames: [frame('received', '{"type":"price","value":10}')] }),
      ],
    });
    const current = report([], {
      webSockets: [socket({ url: 'wss://example.com/live', frames: [frame('received', '{"type":"price"}')] })],
    });

    const change = changeFor(diffReports(baseline, current), 'WS wss://example.com/live');
    expect(change.kind).toBe('changed');
    expect(change.breaking).toBe(true);
    expect(change.details).toContain('WebSocket received message field removed: value');
  });

  it('treats an added WebSocket message field as non-breaking', () => {
    const baseline = report([], {
      webSockets: [socket({ url: 'wss://example.com/live', frames: [frame('sent', '{"subscribe":true}')] })],
    });
    const current = report([], {
      webSockets: [
        socket({
          url: 'wss://example.com/live',
          frames: [frame('sent', '{"subscribe":true,"channel":"prices"}')],
        }),
      ],
    });

    const change = changeFor(diffReports(baseline, current), 'WS wss://example.com/live');
    expect(change.breaking).toBe(false);
    expect(change.details).toContain('WebSocket sent message field added: channel');
  });

  it('counts each kind separately and sorts changes by id', () => {
    const baseline = report([endpoint({ id: 'GET /b' }), endpoint({ id: 'GET /gone' })]);
    const current = report([endpoint({ id: 'GET /a' }), endpoint({ id: 'GET /b', statusCodes: [500] })]);

    const diff = diffReports(baseline, current);

    expect(diff.counts).toMatchObject({ added: 1, removed: 1, changed: 1 });
    expect(diff.changes.map((c) => c.id)).toEqual(['GET /a', 'GET /b', 'GET /gone']);
  });
});

describe('formatDiffSummary', () => {
  it('says so plainly when nothing changed', () => {
    const diff = diffReports(report([]), report([]));
    expect(formatDiffSummary(diff)).toEqual(['No endpoint changes since the baseline.']);
  });

  it('notes an engine difference between the two scans', () => {
    const current = report([], { meta: { ...report([]).meta, engine: 'firefox' } });

    const lines = formatDiffSummary(diffReports(report([]), current)).join('\n');

    expect(lines).toContain('the baseline ran in chromium and this scan in firefox');
    expect(lines).toContain('engine-specific');
  });

  it('stays quiet when both scans used the same engine', () => {
    const lines = formatDiffSummary(diffReports(report([]), report([]))).join('\n');
    expect(lines).not.toContain('engine-specific');
  });

  it('summarises counts and marks breaking changes', () => {
    const diff = diffReports(report([endpoint({ id: 'GET /gone' })]), report([endpoint({ id: 'GET /new' })]));

    const lines = formatDiffSummary(diff).join('\n');
    expect(lines).toContain('1 added, 1 removed, 0 changed (1 breaking)');
    expect(lines).toContain('+ GET /new');
    expect(lines).toContain('- GET /gone [breaking]');
  });

  it('truncates long change lists', () => {
    const current = report(
      Array.from({ length: 5 }, (_, i) => endpoint({ id: `GET /e${i}` })),
    );

    const lines = formatDiffSummary(diffReports(report([]), current), 2);

    expect(lines.filter((l) => l.startsWith('  +'))).toHaveLength(2);
    expect(lines.join('\n')).toContain('and 3 more');
  });
});

describe('loadBaseline', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'api-recon-diff-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(name: string, contents: string): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, contents, 'utf8');
    return file;
  }

  it('reads a valid report', async () => {
    const file = await write('ok.json', JSON.stringify(report([endpoint({ id: 'GET /api/x' })])));

    const loaded = await loadBaseline(file);
    expect(loaded.endpoints.map((e) => e.id)).toEqual(['GET /api/x']);
  });

  it('rejects a missing file', async () => {
    await expect(loadBaseline(join(dir, 'nope.json'))).rejects.toThrow(SafetyError);
    await expect(loadBaseline(join(dir, 'nope.json'))).rejects.toThrow(/not found or unreadable/);
  });

  it('rejects malformed JSON', async () => {
    const file = await write('bad.json', '{ not json');
    await expect(loadBaseline(file)).rejects.toThrow(/not valid JSON/);
  });

  it('rejects JSON that is not a report', async () => {
    const file = await write('shape.json', JSON.stringify({ hello: 'world' }));
    await expect(loadBaseline(file)).rejects.toThrow(/must be an api-recon report/);
  });
});
