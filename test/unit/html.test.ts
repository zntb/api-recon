import { describe, expect, it } from 'vitest';
import { renderHtml } from '../../src/reporters/html.js';

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
});
