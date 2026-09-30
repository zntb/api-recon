import { describe, expect, it } from 'vitest';
import { renderHtml } from '../../src/reporters/html.js';
import { renderMarkdown } from '../../src/reporters/markdown.js';
import type { ReconReport } from '../../src/types.js';

function report(): ReconReport {
  return {
    schemaVersion: 1,
    meta: {
      seedUrl: 'https://example.com',
      startedAt: '2026-09-01T00:00:00.000Z',
      durationMs: 1000,
      pagesVisited: 1,
      apiReconVersion: '0.2.2',
      engine: 'chromium',
    },
    technologies: [],
    endpoints: [
      {
        id: 'GET /api/products',
        method: 'GET',
        urlPattern: '/api/products',
        origins: ['https://example.com'],
        category: 'data-fetching',
        count: 2,
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
        triggeredBy: ['https://example.com/products'],
      },
    ],
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

describe('renderHtml', () => {
  it('uses the shared theme tokens and code treatment', async () => {
    const html = await renderHtml('# Title\n\n`inline`\n\n```js\nconst a = 1;\n```\n', 'Report');

    // Tokens come from theme.ts, shared with dashboard.html.
    expect(html).toContain('--font-mono');
    expect(html).toContain('--pre-bg');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('code { font-family: var(--font-mono)');
  });

  it('wraps tables so an unbreakable cell scrolls instead of widening the page', async () => {
    const markdown = '| Field | Value |\n| --- | --- |\n| url | https://example.com/a/very/long/path |\n';
    const html = await renderHtml(markdown, 'Report');

    expect(html).toContain('<div class="table-scroll"><table>');
    expect(html).toContain('</table></div>');
    expect(html).toContain('.table-scroll { overflow-x: auto; }');
  });

  it('escapes the title', async () => {
    const html = await renderHtml('body', '<b>evil</b> & co');
    expect(html).toContain('<title>&lt;b&gt;evil&lt;/b&gt; &amp; co</title>');
  });

  it('keeps one endpoint detail together when printing', async () => {
    const markdown = [
      '## 4. Detailed Endpoints',
      '',
      '### `GET /api/products`',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| Status codes | 200 |',
      '',
      '### `POST /api/search`',
      '',
      '| Field | Value |',
      '| --- | --- |',
      '| Status codes | 200 |',
    ].join('\n');
    const html = await renderHtml(markdown, 'Report');

    // Each `###` block becomes its own section, and the print rule keeps it whole.
    expect(html.match(/<section class="detail">/g)).toHaveLength(2);
    expect(html).toContain('<section class="detail"><h3>');
    expect(html).toContain('section.detail { break-inside: avoid; }');
    // The heading still never strands at the foot of a page.
    expect(html).toContain('h2, h3 { break-after: avoid; }');
    expect((html.match(/<\/section>/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('replaces the Mermaid graph with inline SVG, and styles it from the theme', async () => {
    const recon = report();
    const html = await renderHtml(renderMarkdown(recon), 'Report', recon);

    expect(html).toContain('<svg class="request-graph"');
    expect(html).toContain('/products');
    expect(html).toContain('GET /api/products');
    expect(html).not.toContain('language-mermaid');
    expect(html).toContain('.request-graph .rg-edge');
    expect(html).toContain('.request-graph .rg-page rect');
  });

  it('leaves the Mermaid fence as a code block when there is no report to draw', async () => {
    const markdown = '## 13. Request Graph\n\n```mermaid\nflowchart LR\n  p0 --> e0\n```\n';
    const html = await renderHtml(markdown, 'Report');

    expect(html).toContain('language-mermaid');
    expect(html).not.toContain('<svg class="request-graph"');
  });
});
