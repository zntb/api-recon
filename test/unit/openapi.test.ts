import { describe, expect, it } from 'vitest';
import { buildOpenApi, toOpenApiSchema } from '../../src/reporters/openapi.js';
import type { Endpoint, ReconReport } from '../../src/types.js';

const SEED = 'https://example.com';

function report(endpoints: Endpoint[]): ReconReport {
  return {
    meta: {
      seedUrl: SEED,
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
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
      rateLimitMs: 0,
      maxBodyBytes: 1024,
      allowLocal: true,
      redact: true,
    },
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

/** The responses the reporter wrote for one operation, keyed by status. */
type Responses = Record<
  string,
  { content?: { 'application/json'?: { schema: Record<string, unknown> } } }
>;

function responsesFor(api: ReconReport | Record<string, unknown>, path: string): Responses {
  const paths = (api as { paths: Record<string, Record<string, { responses: Responses }>> }).paths;
  return paths[path]!['get']!.responses;
}

describe('toOpenApiSchema', () => {
  it('maps a plain schema, including nested fields and format hints', () => {
    expect(
      toOpenApiSchema({
        type: 'object',
        properties: {
          id: { type: 'string', description: 'uuid' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['id'],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        id: { type: 'string', format: 'uuid' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    });
  });

  it('carries a merged union through as oneOf', () => {
    expect(
      toOpenApiSchema({ oneOf: [{ type: 'string' }, { type: 'integer' }] }),
    ).toEqual({ oneOf: [{ type: 'string' }, { type: 'integer' }] });
  });

  it('renders a null schema as a nullable string', () => {
    expect(toOpenApiSchema({ type: 'null' })).toEqual({ type: 'string', nullable: true });
  });

  it('returns an empty object for no schema at all', () => {
    expect(toOpenApiSchema(null)).toEqual({});
  });
});

describe('buildOpenApi', () => {
  it('gives each error status its own schema instead of the success shape', () => {
    const api = buildOpenApi(
      report([
        endpoint({
          id: 'GET /api/orders',
          statusCodes: [200, 404],
          responseSchema: { type: 'object', properties: { orders: { type: 'array' } } },
          errorResponses: [
            {
              status: 404,
              count: 1,
              bodySample: '{"error":"not_found"}',
              schema: { type: 'object', properties: { error: { type: 'string' } } },
              mimeTypes: ['application/json'],
            },
          ],
        }),
      ]),
    );

    const responses = responsesFor(api, '/api/orders');
    const schemaFor = (status: string): Record<string, unknown> | undefined =>
      responses[status]?.content?.['application/json']?.schema;

    expect(schemaFor('200')?.properties).toHaveProperty('orders');
    expect(schemaFor('404')?.properties).toHaveProperty('error');
  });

  it('falls back to the success schema for an error status with no captured body', () => {
    const api = buildOpenApi(
      report([
        endpoint({
          id: 'GET /api/orders',
          statusCodes: [200, 500],
          responseSchema: { type: 'object', properties: { orders: { type: 'array' } } },
        }),
      ]),
    );

    const responses = responsesFor(api, '/api/orders');
    expect(responses['500']?.content?.['application/json']?.schema.properties).toHaveProperty('orders');
  });
});
