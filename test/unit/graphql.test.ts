import { describe, expect, it } from 'vitest';
import { analyzeGraphQL, mergeGraphQL, parseGraphQLDocument } from '../../src/core/graphql.js';
import { categorize } from '../../src/core/analyzer.js';
import type { CapturedCall } from '../../src/types.js';

function call(overrides: Partial<CapturedCall> = {}): CapturedCall {
  return {
    method: 'POST',
    url: 'https://example.com/graphql',
    status: 200,
    mimeType: 'application/json',
    resourceType: 'fetch',
    requestHeaders: { 'content-type': 'application/json' },
    requestBodySample: null,
    responseHeaders: { 'content-type': 'application/json' },
    responseBodySample: '{"data":{}}',
    responseBodyTruncated: false,
    startedAt: 0,
    durationMs: 1,
    triggeredBy: 'https://example.com/',
    ...overrides,
  };
}

function post(body: unknown, overrides: Partial<CapturedCall> = {}): CapturedCall {
  return call({ requestBodySample: JSON.stringify(body), ...overrides });
}

describe('parseGraphQLDocument', () => {
  it('reads named operations and their types', () => {
    const parsed = parseGraphQLDocument('query GetUser { user { id } }');
    expect(parsed.operations).toEqual([{ name: 'GetUser', type: 'query' }]);

    const mixed = parseGraphQLDocument('query A { a } mutation B { b } subscription C { c }');
    expect(mixed.operations).toEqual([
      { name: 'A', type: 'query' },
      { name: 'B', type: 'mutation' },
      { name: 'C', type: 'subscription' },
    ]);
  });

  it('treats the anonymous query shorthand as a query', () => {
    expect(parseGraphQLDocument('{ products { id } }').operations).toEqual([
      { name: null, type: 'query' },
    ]);
  });

  it('ignores keywords in nested fields, strings, comments, and fragments', () => {
    const nested = parseGraphQLDocument('query GetProducts { query { id } mutation { state } }');
    expect(nested.operations).toEqual([{ name: 'GetProducts', type: 'query' }]);

    const noisy = parseGraphQLDocument(
      '# query NotReal\nquery Real { field(arg: "mutation AlsoNotReal") }',
    );
    expect(noisy.operations).toEqual([{ name: 'Real', type: 'query' }]);

    const withFragment = parseGraphQLDocument(
      'fragment Fields on Query { id } query WithFragment { ...Fields }',
    );
    expect(withFragment.operations).toEqual([{ name: 'WithFragment', type: 'query' }]);
  });

  it('skips variable definitions and directives before the selection set', () => {
    const parsed = parseGraphQLDocument(
      'query GetProducts($first: Int = 3, $filter: Filter = { status: "open" }) @cached(ttl: 60) { products { id } }',
    );
    expect(parsed.operations).toEqual([{ name: 'GetProducts', type: 'query' }]);
  });

  it('flags schema introspection fields', () => {
    expect(parseGraphQLDocument('query { __schema { types { name } } }').introspection).toBe(true);
    expect(parseGraphQLDocument('query { __type(name: "User") { name } }').introspection).toBe(true);
    // `__typename` is an ordinary field, not introspection.
    expect(parseGraphQLDocument('query { user { __typename } }').introspection).toBe(false);
  });
});

describe('analyzeGraphQL', () => {
  it('detects a POST with a JSON query document and named operation', () => {
    const info = analyzeGraphQL(
      post({ query: 'query GetProducts { products { id } }', operationName: 'GetProducts' }),
    );
    expect(info).toEqual({
      introspection: false,
      operations: [{ name: 'GetProducts', type: 'query' }],
    });
  });

  it('detects an introspection query', () => {
    const info = analyzeGraphQL(
      post({
        operationName: 'IntrospectionQuery',
        query: 'query IntrospectionQuery { __schema { queryType { name } } }',
      }),
    );
    expect(info?.introspection).toBe(true);
    expect(info?.operations).toEqual([{ name: 'IntrospectionQuery', type: 'query' }]);
  });

  it('records an operation name the document did not declare', () => {
    const info = analyzeGraphQL(
      post({ query: 'query Other { viewer { id } }', operationName: 'GetViewer' }),
    );
    expect(info?.operations).toEqual([
      { name: 'GetViewer', type: 'unknown' },
      { name: 'Other', type: 'query' },
    ]);
  });

  it('detects GET requests that carry the query in the URL', () => {
    const info = analyzeGraphQL(
      call({
        method: 'GET',
        url: 'https://example.com/graphql?query=query%20GetViewer%7Bviewer%7Bid%7D%7D&operationName=GetViewer',
        requestBodySample: null,
      }),
    );
    expect(info?.operations).toEqual([{ name: 'GetViewer', type: 'query' }]);
  });

  it('detects an application/graphql body', () => {
    const info = analyzeGraphQL(
      call({
        requestHeaders: { 'content-type': 'application/graphql' },
        requestBodySample: 'query GetViewer { viewer { id } }',
      }),
    );
    expect(info?.operations).toEqual([{ name: 'GetViewer', type: 'query' }]);
  });

  it('recognizes an automatic persisted query from its operation name', () => {
    const info = analyzeGraphQL(
      post({ operationName: 'PersistedProducts', extensions: { persistedQuery: { sha256Hash: 'abc' } } }),
    );
    expect(info).toEqual({
      introspection: false,
      operations: [{ name: 'PersistedProducts', type: 'unknown' }],
    });
  });

  it('leaves ordinary JSON APIs alone', () => {
    expect(analyzeGraphQL(post({ q: 'widget' }))).toBeNull();
    // A `query` key whose value is not a GraphQL document is not GraphQL.
    expect(analyzeGraphQL(post({ query: 'widget search' }))).toBeNull();
    // A lone operation name off a GraphQL path is too weak a signal.
    expect(analyzeGraphQL(post({ operationName: 'GetViewer' }, { url: 'https://example.com/api/search' }))).toBeNull();
    expect(analyzeGraphQL(call({ url: 'https://example.com/api/products' }))).toBeNull();
  });
});

describe('mergeGraphQL', () => {
  it('dedupes operations and ORs the introspection flag', () => {
    const merged = mergeGraphQL([
      { introspection: false, operations: [{ name: 'A', type: 'query' }] },
      {
        introspection: true,
        operations: [
          { name: 'A', type: 'query' },
          { name: 'B', type: 'mutation' },
        ],
      },
      null,
    ]);
    expect(merged).toEqual({
      introspection: true,
      operations: [
        { name: 'A', type: 'query' },
        { name: 'B', type: 'mutation' },
      ],
    });
  });

  it('returns null when nothing was GraphQL', () => {
    expect(mergeGraphQL([null, null])).toBeNull();
  });
});

describe('categorize with GraphQL', () => {
  const seed = 'https://example.com';

  it('categorizes a detected GraphQL call as graphql', () => {
    expect(categorize(call(), seed, true)).toBe('graphql');
    expect(categorize(call(), seed, false)).toBe('mutations');
  });

  it('keeps authentication and third-party precedence', () => {
    expect(categorize(call({ url: 'https://example.com/api/login' }), seed, true)).toBe('authentication');
    expect(categorize(call({ url: 'https://other.example.org/graphql' }), seed, true)).toBe('third-party');
  });
});
