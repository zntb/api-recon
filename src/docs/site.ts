/**
 * The documentation site.
 *
 * The README is the front door, but the detailed material — a recipe per kind
 * of app, and the questions that come up when a scan misbehaves — outgrew it.
 * That material lives as Markdown under `docs/`, and this module renders it into
 * a small static site under `docs-site/` with the same theme as every other
 * artifact (`theme.ts` and `brand.ts`), so the docs look like the product and
 * carry no generator of their own.
 *
 * Links between pages are written as `.md` (so the sources also read correctly
 * on GitHub) and rewritten to `.html` here. The output is deterministic, so a
 * committed site can be diffed the way the completion scripts are.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { marked } from 'marked';
import { CODE_STYLE, THEME_TOKENS } from '../reporters/theme.js';
import { BRAND_STYLE, brandMark, faviconLink } from '../reporters/brand.js';

export interface DocsPageSource {
  /** Path relative to `docs/`, e.g. `cookbook/graphql.md`. */
  file: string;
  /** Short label for the sidebar. */
  nav: string;
  /** Page title, for `<title>` and the sidebar heading. */
  title: string;
}

/** The pages, in the order they appear in the sidebar. */
export const DOCS_PAGES: DocsPageSource[] = [
  { file: 'index.md', nav: 'Overview', title: 'api-recon documentation' },
  { file: 'cookbook/authenticated-spa.md', nav: 'Authenticated SPA', title: 'Scan an authenticated SPA' },
  { file: 'cookbook/graphql.md', nav: 'GraphQL', title: 'Scan a GraphQL endpoint' },
  { file: 'cookbook/websocket.md', nav: 'WebSockets', title: 'Scan a WebSocket app' },
  { file: 'cookbook/ci-gate.md', nav: 'CI gate', title: 'Gate CI on API changes' },
  { file: 'faq.md', nav: 'Troubleshooting FAQ', title: 'Troubleshooting FAQ' },
];

export interface GeneratedFile {
  /** Path relative to the output directory, e.g. `cookbook/graphql.html`. */
  path: string;
  contents: string;
}

/** The stylesheet: the shared theme plus the two-column docs layout. */
export function docsCss(): string {
  return `${THEME_TOKENS}${CODE_STYLE}${BRAND_STYLE}
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; font-family: var(--font-sans); background: var(--bg); color: var(--ink); line-height: 1.6; }
  .layout { display: grid; grid-template-columns: 250px minmax(0, 1fr); }
  .sidebar { position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto;
    background: var(--panel); border-right: 1px solid var(--line); padding: 1.4rem 1rem; }
  .brand { display: flex; align-items: center; gap: .5rem; font-weight: 700; text-decoration: none;
    color: var(--ink); margin-bottom: 1.1rem; }
  .brand .brand-mark { margin: 0; }
  .sidebar ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .15rem; }
  .sidebar a { display: block; padding: .4rem .6rem; border-radius: var(--radius-sm);
    color: var(--muted); text-decoration: none; font-size: .92rem; }
  .sidebar a:hover { background: var(--row-hover); color: var(--ink); }
  .sidebar a.active { background: var(--note-bg); color: var(--link); font-weight: 600; }
  main { padding: 2.5rem 2rem; max-width: 920px; }
  article { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 2.2rem; box-shadow: var(--shadow); }
  h1 { font-size: 1.9rem; margin-top: 0; letter-spacing: -0.02em; }
  h2 { font-size: 1.28rem; margin-top: 2.2rem; padding-bottom: .35rem; border-bottom: 2px solid var(--chip); }
  h3 { font-size: 1.06rem; margin-top: 1.6rem; }
  a { color: var(--link); }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: .9rem; }
  th, td { text-align: left; padding: .5rem .65rem; border: 1px solid var(--line); vertical-align: top; }
  th { background: var(--head); font-weight: 600; }
  tr:nth-child(even) td { background: var(--panel-2); }
  blockquote { margin: 1rem 0; padding: .6rem 1rem; border-left: 4px solid var(--accent-soft);
    background: var(--note-bg); }
  footer { margin: 1.5rem 0 3rem; color: var(--muted); font-size: .85rem; }
  footer a { color: var(--muted); }
  @media (max-width: 820px) {
    .layout { grid-template-columns: 1fr; }
    .sidebar { position: static; height: auto; border-right: none; border-bottom: 1px solid var(--line); }
    main { padding: 1.4rem 1rem; }
    article { padding: 1.4rem; }
  }
  @media print {
    .sidebar { display: none; }
    .layout { grid-template-columns: 1fr; }
    body { background: #fff; }
    article { border: none; box-shadow: none; padding: 0; }
    h2, h3 { break-after: avoid; }
    pre, table, tr { break-inside: avoid; }
  }
`;
}

/** A Markdown `.md` link is a `.html` link once the site is built. */
function toSiteLinks(html: string): string {
  return html.replace(
    /href="([^"#:]+)\.md(#[^"]*)?"/g,
    (_match, path: string, hash: string | undefined) => `href="${path}.html${hash ?? ''}"`,
  );
}

/** `../` repeated for how deep an output path sits, for relative assets/links. */
function prefixFor(outputPath: string): string {
  const depth = outputPath.split('/').length - 1;
  return '../'.repeat(depth);
}

function sidebar(current: DocsPageSource, prefix: string): string {
  const items = DOCS_PAGES.map((page) => {
    const href = `${prefix}${page.file.replace(/\.md$/, '.html')}`;
    const active = page.file === current.file ? ' class="active"' : '';
    return `<li><a href="${href}"${active}>${escapeHtml(page.nav)}</a></li>`;
  }).join('');
  return (
    `<nav class="sidebar">` +
    `<a class="brand" href="${prefix}index.html">${brandMark(22)}<span>api-recon</span></a>` +
    `<ul>${items}</ul>` +
    `</nav>`
  );
}

function pageHtml(page: DocsPageSource, outputPath: string, body: string): string {
  const prefix = prefixFor(outputPath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
${faviconLink()}
<title>${escapeHtml(page.title)} · api-recon</title>
<link rel="stylesheet" href="${prefix}style.css" />
</head>
<body>
<div class="layout">
${sidebar(page, prefix)}
<main>
<article>
${body}
</article>
<footer>api-recon documentation — see the <a href="https://github.com/zntb/api-recon#readme">README</a> for the full CLI and library reference.</footer>
</main>
</div>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render every page under `docsDir`, plus the stylesheet, into the files that
 * make up the site. Paths are relative to the output directory.
 */
export async function buildDocsSite(docsDir: string): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];

  for (const page of DOCS_PAGES) {
    const markdown = await readFile(join(docsDir, page.file), 'utf8');
    const body = toSiteLinks(await marked.parse(markdown, { async: true, gfm: true }));
    const outputPath = page.file.replace(/\.md$/, '.html');
    files.push({ path: outputPath, contents: pageHtml(page, outputPath, body.trimEnd()) });
  }

  files.push({ path: 'style.css', contents: docsCss() });
  return files;
}
