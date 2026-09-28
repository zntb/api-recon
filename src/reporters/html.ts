/** HTML reporter: renders the Markdown report into a styled standalone page. */

import { marked } from 'marked';

const STYLE = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 2.5rem 1.25rem;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #f6f7f9; color: #1c2430; line-height: 1.55;
  }
  main { max-width: 980px; margin: 0 auto; background: #fff; border: 1px solid #e3e7ee;
    border-radius: 12px; padding: 2.5rem; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
  h1 { font-size: 1.9rem; margin-top: 0; letter-spacing: -0.02em; }
  h2 { font-size: 1.3rem; margin-top: 2.2rem; padding-bottom: .35rem; border-bottom: 2px solid #eef1f6; }
  h3 { font-size: 1.05rem; margin-top: 1.6rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em;
    background: #f1f3f7; padding: .12em .35em; border-radius: 4px; }
  pre { background: #0f172a; color: #e2e8f0; padding: 1rem 1.1rem; border-radius: 8px;
    overflow-x: auto; font-size: .82rem; line-height: 1.45; }
  pre code { background: none; color: inherit; padding: 0; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: .9rem; }
  th, td { text-align: left; padding: .5rem .65rem; border: 1px solid #e3e7ee; vertical-align: top; }
  th { background: #f4f6fa; font-weight: 600; }
  tr:nth-child(even) td { background: #fafbfd; }
  blockquote { margin: 1rem 0; padding: .5rem 1rem; border-left: 4px solid #c7d2fe; background: #f8faff; }
  hr { border: none; border-top: 1px solid #e3e7ee; margin: 2rem 0; }
  @media print {
    body { background: #fff; padding: 0; }
    main { border: none; box-shadow: none; padding: 0; max-width: none; }
    pre { background: #f4f4f5; color: #111; border: 1px solid #ddd; }
    h2, h3 { break-after: avoid; }
    table, pre, tr { break-inside: avoid; }
  }
`;

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
${body}
</main>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
