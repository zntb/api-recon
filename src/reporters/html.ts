/** HTML reporter: renders the Markdown report into a styled standalone page. */

import { marked } from 'marked';
import { CODE_STYLE, THEME_TOKENS } from './theme.js';

// The palette, typography, and code treatment come from the shared theme so
// this page and dashboard.html stay one product; only the document layout is
// local to this reporter.
const STYLE = `${THEME_TOKENS}${CODE_STYLE}
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem;
    font-family: var(--font-sans);
    background: var(--bg); color: var(--ink); line-height: 1.55;
  }
  main { max-width: 980px; margin: 0 auto; background: var(--panel);
    border: 1px solid var(--line); border-radius: var(--radius); padding: 2.5rem;
    box-shadow: var(--shadow); }
  h1 { font-size: 1.9rem; margin-top: 0; letter-spacing: -0.02em; }
  h2 { font-size: 1.3rem; margin-top: 2.2rem; padding-bottom: .35rem; border-bottom: 2px solid var(--chip); }
  h3 { font-size: 1.05rem; margin-top: 1.6rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: .9rem; }
  th, td { text-align: left; padding: .5rem .65rem; border: 1px solid var(--line); vertical-align: top; }
  th { background: var(--head); font-weight: 600; }
  tr:nth-child(even) td { background: var(--panel-2); }
  blockquote { margin: 1rem 0; padding: .5rem 1rem; border-left: 4px solid var(--accent-soft);
    background: var(--note-bg); }
  hr { border: none; border-top: 1px solid var(--line); margin: 2rem 0; }
  .cat-badge { display: inline-block; padding: .05rem .5rem; border-radius: 99px;
    font-size: .78em; font-weight: 600; background: var(--chip); color: var(--chip-ink); }
  .cat-badge.cat-authentication, .cat-badge.cat-mutations { background: var(--warn-bg); color: var(--warn); }
  .cat-badge.cat-analytics, .cat-badge.cat-graphql { background: var(--info-bg); color: var(--info); }
  .cat-badge.cat-third-party { background: var(--bad-bg); color: var(--bad); }
  .cat-badge.cat-data-fetching { background: var(--ok-bg); color: var(--ok); }
  @media print {
    body { background: #fff; padding: 0; }
    main { border: none; box-shadow: none; padding: 0; max-width: none; }
    h2, h3 { break-after: avoid; }
    table, pre, tr { break-inside: avoid; }
    /* One endpoint's detail stays on one page: a heading stranded at the foot
       of a page, or a table split across two, is what makes a printed report
       hard to follow. Best-effort — a detail taller than a page still breaks. */
    section.detail { break-inside: avoid; }
  }
`;

/**
 * Put every table in its own scroll box. A cell holding an unbreakable string —
 * a long URL, a payload — then scrolls horizontally instead of widening the
 * page past the viewport.
 */
function wrapTables(html: string): string {
  return html
    .replace(/<table>/g, '<div class="table-scroll"><table>')
    .replace(/<\/table>/g, '</table></div>');
}

/**
 * Wrap each `###` block — one endpoint's detail, one resource, one finding
 * group — in a `section.detail`, so the print rules can keep it whole. Markdown
 * has no way to express "keep this together", and a heading is the only signal
 * for where one unit ends and the next begins.
 */
export function wrapDetailSections(html: string): string {
  const parts = html.split(/(?=<h3[\s>])/);
  if (parts.length < 2) return html;
  const [head, ...sections] = parts;
  return `${head}${sections.map((section) => `<section class="detail">${section}</section>`).join('')}`;
}

export async function renderHtml(markdown: string, title: string): Promise<string> {
  const body = await marked.parse(markdown, { async: true, gfm: true });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${wrapDetailSections(wrapTables(body))}
</main>
</body>
</html>
`;
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
