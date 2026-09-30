import { describe, expect, it } from 'vitest';
import {
  buildRequestGraph,
  renderRequestGraphSvg,
  toMermaid,
} from '../../src/reporters/graph.js';
import type { Endpoint, ReconReport } from '../../src/types.js';
import { REPORT_SCHEMA_VERSION } from '../../src/types.js';

function endpoint(id: string, triggeredBy: string[], count = 1): Endpoint {
  const [method, urlPattern] = id.split(' ') as [string, string];
  return {
    id,
    method,
    urlPattern,
    origins: ['https://example.com'],
    category: 'data-fetching',
    count,
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
    triggeredBy,
  };
}

function report(endpoints: Endpoint[], seedUrl = 'https://example.com'): ReconReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    meta: {
      seedUrl,
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1000,
      pagesVisited: 2,
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
      redact: true,
      allowLocal: true,
    },
  };
}

describe('buildRequestGraph', () => {
  it('joins each endpoint to the page that triggered it', () => {
    const graph = buildRequestGraph(
      report([
        endpoint('GET /api/products', ['https://example.com/products', 'https://example.com/']),
        endpoint('POST /api/search', ['https://example.com/products'], 4),
      ]),
    );

    expect(graph.pages.map((p) => p.label)).toEqual([
      '/products',
      '/',
    ]);
    expect(graph.requests.map((r) => r.label).sort()).toEqual([
      'GET /api/products',
      'POST /api/search',
    ]);
    // /products triggered both, / triggered only products.
    expect(graph.edges).toHaveLength(3);
    expect(graph.pages[0]!.calls).toBe(2);
    expect(graph.requests.find((r) => r.label === 'POST /api/search')!.calls).toBe(4);
  });

  it('ranks pages and requests by activity, not by input order', () => {
    const graph = buildRequestGraph(
      report([
        endpoint('GET /quiet', ['https://example.com/quiet']),
        endpoint('GET /busy', ['https://example.com/busy'], 99),
      ]),
    );
    expect(graph.requests[0]!.label).toBe('GET /busy');
    expect(graph.requests[1]!.label).toBe('GET /quiet');
  });

  it('keeps the host on a page that is not the seed host', () => {
    const graph = buildRequestGraph(
      report([endpoint('GET /collect', ['https://metrics.example.net/collect'])], 'https://example.com'),
    );
    expect(graph.pages[0]!.label).toBe('metrics.example.net/collect');
  });

  it('leaves out an endpoint whose triggering page was never recorded', () => {
    const graph = buildRequestGraph(report([endpoint('GET /api/orphan', [])]));
    expect(graph.pages).toEqual([]);
    expect(graph.requests).toEqual([]);
    expect(graph.edges).toEqual([]);
  });

  it('caps the drawing and counts what it left out', () => {
    const endpoints = Array.from({ length: 5 }, (_, i) =>
      endpoint(`GET /api/thing-${i}`, ['https://example.com/a', 'https://example.com/b']),
    );
    const graph = buildRequestGraph(report(endpoints), { maxPages: 1, maxRequests: 2 });

    expect(graph.pages).toHaveLength(1);
    expect(graph.requests).toHaveLength(2);
    expect(graph.omittedPages).toBe(1);
    expect(graph.omittedRequests).toBe(3);
    // Only the requests that survived may carry an edge.
    const ids = new Set(graph.requests.map((r) => r.id));
    expect(graph.edges.every((edge) => ids.has(edge.to))).toBe(true);
  });

  it('names every node with an opaque id so labels need no escaping', () => {
    const graph = buildRequestGraph(report([endpoint('GET /api/a"b', ['https://example.com/x'])], 'https://example.com'));
    expect(graph.requests[0]!.id).toBe('e0');
    expect(graph.requests[0]!.label).toBe('GET /api/a"b');
  });
});

describe('toMermaid', () => {
  it('emits a left-to-right flowchart of pages to requests', () => {
    const graph = buildRequestGraph(
      report([endpoint('GET /api/products', ['https://example.com/products'])]),
    );
    const mermaid = toMermaid(graph);

    expect(mermaid.split('\n')[0]).toBe('flowchart LR');
    expect(mermaid).toContain('p0["/products"]');
    expect(mermaid).toContain('e0["GET /api/products"]');
    expect(mermaid).toContain('p0 --> e0');
  });

  it('escapes a quote that would end a Mermaid label early', () => {
    const graph = buildRequestGraph(
      report([endpoint('GET /api/a"b', ['https://example.com/x'])]),
    );
    expect(toMermaid(graph)).toContain('e0["GET /api/a#quot;b"]');
  });
});

describe('renderRequestGraphSvg', () => {
  const graph = buildRequestGraph(
    report([
      endpoint('GET /api/products', ['https://example.com/products']),
      endpoint('POST /api/search', ['https://example.com/products'], 8),
      endpoint('GET /api/orders', ['https://example.com/orders']),
    ]),
  );

  it('draws a self-contained, labelled SVG', () => {
    const svg = renderRequestGraphSvg(graph);
    expect(svg.startsWith('<svg class="request-graph"')).toBe(true);
    expect(svg).toContain('viewBox="0 0 ');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Pages and the requests they triggered"');
    // One box per node, one curve per edge.
    expect(svg.match(/<g class="rg-node /g)).toHaveLength(5);
    expect(svg.match(/class="rg-edge"/g)).toHaveLength(3);
    expect(svg).toContain('/products');
    expect(svg).toContain('GET /api/orders');
  });

  it('weights an edge by how often the request was made', () => {
    const svg = renderRequestGraphSvg(graph);
    const widths = [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(new Set(widths).size).toBeGreaterThan(1);
    // The 8-call edge is heavier than the 1-call edges.
    expect(Math.max(...widths)).toBeGreaterThan(Math.min(...widths));
  });

  it('stays deterministic so the example reports can be regenerated', () => {
    expect(renderRequestGraphSvg(graph)).toBe(renderRequestGraphSvg(graph));
  });

  it('escapes a label that would otherwise inject markup', () => {
    const nasty = buildRequestGraph(
      report([endpoint('GET /api/<script>', ['https://example.com/x'])]),
    );
    const svg = renderRequestGraphSvg(nasty);
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
  });

  it('clips an overlong label but keeps the full text in a title', () => {
    const long = `GET /api/${'segment/'.repeat(30)}end`;
    const svg = renderRequestGraphSvg(buildRequestGraph(report([endpoint(long, ['https://example.com/x'])])));
    expect(svg).toContain('…');
    expect(svg).toContain(`<title>${long}</title>`);
  });
});
