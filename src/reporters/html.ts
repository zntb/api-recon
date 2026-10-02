/** HTML reporter: renders the Markdown report into a styled standalone page. */

import { marked } from 'marked';
import type { ReconReport } from '../types.js';
import { CODE_STYLE, GRAPH_STYLE, THEME_TOKENS } from './theme.js';
import { buildRequestGraph, renderRequestGraphSvg } from './graph.js';
import { BRAND_STYLE, brandMark, faviconLink } from './brand.js';

// The palette, typography, and code treatment come from the shared theme so
// this page and dashboard.html stay one product; only the document layout is
// local to this reporter.
const STYLE = `${THEME_TOKENS}${CODE_STYLE}${GRAPH_STYLE}${BRAND_STYLE}
  * { box-sizing: border-box; }
  /* The report is a document, so it reads in the serif display face — headings,
     prose, and pull quotes in one voice — while tables, chips, and code break
     back out to the sans and mono faces that suit data. */
  body {
    margin: 0; padding: 2.5rem 1.25rem 4rem;
    font-family: var(--font-display); font-size: 1.02rem;
    background: var(--bg); color: var(--ink); line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }
  main { max-width: 800px; margin: 0 auto; background: var(--panel);
    border: 1px solid var(--line); border-radius: var(--radius); padding: 3rem 2.5rem;
    box-shadow: var(--shadow); }
  h1 { font-family: var(--font-display); font-size: 2.1rem; font-weight: 600;
    margin-top: 0; letter-spacing: -0.015em; line-height: 1.15; }
  h2 { font-family: var(--font-display); font-size: 1.4rem; font-weight: 600;
    margin-top: 2.4rem; padding-bottom: .4rem; border-bottom: 1px solid var(--line); }
  h3 { font-family: var(--font-display); font-size: 1.12rem; font-weight: 600;
    margin-top: 1.7rem; }
  a { color: var(--link); }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: .9rem;
    font-family: var(--font-sans); }
  th, td { text-align: left; padding: .5rem .65rem; border: 1px solid var(--line); vertical-align: top; }
  th { background: var(--head); font-weight: 600; font-size: .84rem; }
  tr:nth-child(even) td { background: var(--panel-2); }
  blockquote { margin: 1rem 0; padding: .5rem 1rem; border-left: 4px solid var(--accent-soft);
    background: var(--note-bg); }
  hr { border: none; border-top: 1px solid var(--line); margin: 2rem 0; }
  .cat-badge { display: inline-block; padding: .05rem .5rem; border-radius: 99px;
    font-family: var(--font-sans); font-size: .78em; font-weight: 600;
    background: var(--chip); color: var(--chip-ink); }
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
/**
 * The report's title becomes its masthead: the mark sits inline with the `<h1>`
 * the Markdown already carries, so the page leads with an identity instead of a
 * bare heading and the heading structure is unchanged.
 */
function addMasthead(body: string): string {
  return body.replace(/(<h1[^>]*>)([\s\S]*?)(<\/h1>)/, `$1${brandMark(26)}$2$3`);
}

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

/**
 * Swap the Markdown report's Mermaid fence for the inline SVG the other Markdown
 * viewers cannot draw. `marked` renders the fence as a `<pre><code>` block, so
 * the graph arrives here as escaped text and leaves as a picture; without a
 * report to draw from, the fence is left alone.
 */
function embedRequestGraph(body: string, report: ReconReport | undefined): string {
  if (!report) return body;
  const graph = buildRequestGraph(report);
  if (graph.edges.length === 0) return body;
  return body.replace(
    /<pre><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/,
    renderRequestGraphSvg(graph),
  );
}

export async function renderHtml(
  markdown: string,
  title: string,
  report?: ReconReport,
): Promise<string> {
  const body = addMasthead(
    embedRequestGraph(await marked.parse(markdown, { async: true, gfm: true }), report),
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${faviconLink()}
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
