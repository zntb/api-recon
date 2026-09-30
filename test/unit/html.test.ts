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
});
