import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeFormats } from '../../src/index.js';
import { renderDashboard, writeDashboardReport } from '../../src/reporters/dashboard.js';
import { REPORT_FORMATS, type Endpoint, type ReconReport, type ReportDiff } from '../../src/types.js';

function endpoint(overrides: Partial<Endpoint> & { id: string }): Endpoint {
  const [method, ...rest] = overrides.id.split(' ');
  return {
    method: method!,
    urlPattern: rest.join(' '),
    origins: ['https://example.com'],
    category: 'data-fetching',
    count: 1,
    statusCodes: [200],
    requestHeaders: { accept: 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBodySample: null,
    responseBodySample: '{"ok":true}',
    pathParams: [],
    queryParams: [],
    requestBodySchema: null,
    responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
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
      durationMs: 1234,
      pagesVisited: 2,
      apiReconVersion: '0.1.2',
      engine: 'chromium',
    },
    technologies: [{ name: 'Express', category: 'framework', evidence: 'x-powered-by: Express' }],
    endpoints,
    pages: [
      { url: 'https://example.com/', normalizedUrl: 'https://example.com/', depth: 0, title: 'Home', visitedAt: 0 },
    ],
    webSockets: [],
    safety: {
      robotsRespected: true,
      robotsSkippedPaths: [],
      rateLimitMs: 500,
      maxBodyBytes: 1048576,
      allowLocal: false,
      redact: true,
    },
    ...overrides,
  };
}

const DIFF: ReportDiff = {
  baseline: { seedUrl: 'https://example.com', startedAt: '2026-08-01T00:00:00.000Z', apiReconVersion: '0.1.1' },
  current: { seedUrl: 'https://example.com', startedAt: '2026-09-01T00:00:00.000Z', apiReconVersion: '0.1.2' },
  changes: [{ id: 'POST /api/login', kind: 'changed', breaking: true, details: ['removed field user.id'] }],
  counts: { added: 0, removed: 0, changed: 1, breaking: 1 },
  hasChanges: true,
};

/** Pull the embedded payload back out of the generated page. */
function embeddedReport(html: string): ReconReport {
  const match = html.match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/);
  if (!match) throw new Error('the dashboard did not embed a report payload');
  return JSON.parse(match[1]!) as ReconReport;
}

/** Every script/link tag the page would fetch from elsewhere. */
function externalReferences(html: string): string[] {
  return html.match(/<(?:script[^>]*\bsrc|link\b|iframe\b|img\b)[^>]*>/gi) ?? [];
}

describe('renderDashboard', () => {
  it('round-trips the whole report through the embedded payload', () => {
    const source = report([endpoint({ id: 'GET /api/products' }), endpoint({ id: 'POST /api/login' })]);
    expect(embeddedReport(renderDashboard(source))).toEqual(source);
  });

  it('is a standalone page with no external references', () => {
    const html = renderDashboard(report([endpoint({ id: 'GET /api/products' })]));
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>');
    expect(externalReferences(html)).toEqual([]);
    // Inline data + inline behaviour: exactly two script elements, both ours.
    expect(html.match(/<script\b/g)).toHaveLength(2);
  });

  it('offers search, filters, sorting, and a reset', () => {
    const html = renderDashboard(report([endpoint({ id: 'GET /api/products' })]));
    for (const id of ['q', 'category', 'method', 'status', 'changed', 'breaking', 'reset']) {
      expect(html, `dashboard should expose #${id}`).toContain(`id="${id}"`);
    }
    expect(html).toContain('data-sort="path"');
    expect(html).toContain('data-sort="count"');
    expect(html).toContain('aria-label="Search endpoints"');
  });

  it('hides the diff-only filter and column when there is no baseline', () => {
    const html = renderDashboard(report([endpoint({ id: 'GET /api/products' })]));
    expect(html).not.toContain('data-sort="change"');
    expect(embeddedReport(html).diff).toBeUndefined();
    // The checkboxes exist, but the script hides them when diff is absent.
    expect(html).toContain("if (!diff) {");
    expect(html).toContain('changedEl.parentNode.hidden = true;');
  });

  it('adds the change column and carries the diff when a baseline is present', () => {
    const html = renderDashboard(
      report([endpoint({ id: 'POST /api/login' })], { diff: DIFF }),
    );
    expect(html).toContain('data-sort="change"');
    const embedded = embeddedReport(html);
    expect(embedded.diff?.counts.breaking).toBe(1);
    expect(embedded.diff?.changes[0]?.details).toEqual(['removed field user.id']);
  });

  it('cannot be broken out of by site-controlled strings', () => {
    const hostile = '/api/x</script><script>alert(1)</script>';
    const html = renderDashboard(
      report([endpoint({ id: `GET ${hostile}`, urlPattern: hostile })]),
    );

    // The tokenizer must only ever see the two closing tags we wrote ourselves.
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html).not.toContain('</script><script>');
    // ...while the data itself survives intact for the client to render.
    expect(embeddedReport(html).endpoints[0]!.urlPattern).toBe(hostile);
  });

  it('escapes the title but keeps the payload raw', () => {
    const html = renderDashboard(report([]), `Report for <b>evil</b> & co`);
    expect(html).toContain('<title>Report for &lt;b&gt;evil&lt;/b&gt; &amp; co</title>');
    expect(html).not.toContain('<b>evil</b>');
  });

  it('escapes a hostile seed URL in the visible header', () => {
    const html = renderDashboard(report([], { meta: { ...report([]).meta, seedUrl: 'https://ex.com/"><script>x</script>' } }));
    expect(html).not.toContain('"><script>x');
    expect(html.match(/<\/script>/g)).toHaveLength(2);
  });

  it('embeds resources and exposes the coverage panel', () => {
    const source = report([endpoint({ id: 'GET /api/orders' })], {
      resources: [
        {
          path: '/api/orders',
          categories: ['data-fetching'],
          paths: [{ path: '/api/orders', methods: ['GET'], missingMethods: ['POST'] }],
        },
      ],
    });

    const html = renderDashboard(source);
    expect(html).toContain('id="resources"');
    expect(embeddedReport(html).resources).toEqual(source.resources);
  });

  it('says so when no endpoints were captured', () => {
    const html = renderDashboard(report([]));
    expect(html).toContain('No endpoints were captured.');
    expect(embeddedReport(html).endpoints).toEqual([]);
  });
});

describe('dashboard as a report format', () => {
  it('is part of the default formats', () => {
    expect(REPORT_FORMATS).toContain('dashboard');
    expect(normalizeFormats(undefined)).toContain('dashboard');
  });

  it('can be selected by name or alias, case-insensitively', () => {
    expect(normalizeFormats(['dashboard'])).toEqual(['dashboard']);
    expect(normalizeFormats(['Dashboard'])).toEqual(['dashboard']);
    expect(normalizeFormats(['dash'])).toEqual(['dashboard']);
    expect(normalizeFormats(['json', 'dashboard'])).toEqual(['json', 'dashboard']);
  });
});

describe('writeDashboardReport', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'api-recon-dash-'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes dashboard.html into the output directory', async () => {
    const file = await writeDashboardReport(report([endpoint({ id: 'GET /api/products' })]), join(dir, 'nested'));
    expect(file.endsWith('dashboard.html')).toBe(true);
    const html = await readFile(file, 'utf8');
    expect(html).toContain('API recon dashboard');
    expect(embeddedReport(html).endpoints[0]!.id).toBe('GET /api/products');
  });
});
