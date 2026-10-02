/**
 * The docs are Markdown sources rendered to a committed site. These check the
 * rendering rules, and that the committed pages match a fresh generation — the
 * same freshness guard the completion scripts use, so editing a source without
 * running `npm run docs:generate` fails the build.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCS_PAGES, buildDocsSite } from '../../src/docs/site.js';

const SITE_DIR = join(process.cwd(), 'docs-site');

describe('docs site', () => {
  it('renders every source page, plus the stylesheet', async () => {
    const paths = (await buildDocsSite('docs')).map((file) => file.path).sort();

    const expected = DOCS_PAGES.map((page) => page.file.replace(/\.md$/, '.html'));
    expect(paths).toEqual([...expected, 'style.css'].sort());
  });

  it('rewrites cross-page .md links to .html, leaving no dead links', async () => {
    const files = await buildDocsSite('docs');

    for (const file of files.filter((entry) => entry.path.endsWith('.html'))) {
      // Only a *relative* `.md` link is dead once rendered: `toSiteLinks`
      // deliberately skips anything carrying a scheme (`[^"#:]+`), so a link
      // out to GitHub stays exactly as written and is correct in the site.
      expect(file.contents, `${file.path} should not link to a relative .md file`).not.toMatch(
        /href="[^":#]+\.md/,
      );
      // Every page carries the sidebar, so each nav label appears.
      for (const page of DOCS_PAGES) {
        expect(file.contents, `${file.path} should link to ${page.nav}`).toContain(page.nav);
      }
    }
  });

  it('links only pages the site actually generates', async () => {
    // A relative link to a directory, or to a Markdown file outside
    // `DOCS_PAGES`, resolves in the repository and dangles in the rendered
    // site — which is what happened with a `../cookbook` directory link.
    const generated = new Set(DOCS_PAGES.map((page) => page.file));
    for (const page of DOCS_PAGES) {
      const source = await readFile(join(process.cwd(), 'docs', page.file), 'utf8');
      const fromDirectory = page.file.split('/').slice(0, -1);
      for (const [, link = ''] of source.matchAll(/\]\(([^)#:]+\.md)(?:#[^)]*)?\)/g)) {
        const segments = fromDirectory.concat(link.split('/'));
        const resolved: string[] = [];
        for (const segment of segments) {
          if (segment === '..') resolved.pop();
          else if (segment !== '.') resolved.push(segment);
        }
        const target = resolved.join('/');
        expect(generated, `${page.file} links to ${target}, which is not a docs page`).toContain(
          target,
        );
      }
    }
  });

  it('keeps a link out of docs/ absolute, since a relative one would dangle', async () => {
    // Asserted on the Markdown sources, not the rendered pages: the generated
    // sidebar and stylesheet link use a `../` prefix legitimately, so only a
    // hand-written link can be wrong. A relative link from `reference/*.md` to
    // `../../schema/…` resolves in the repository but not in the rendered site,
    // so anything leaving `docs/` is written as a full URL instead.
    for (const page of DOCS_PAGES) {
      const source = await readFile(join(process.cwd(), 'docs', page.file), 'utf8');
      // Relative links only: an absolute URL is correct by construction.
      const fromDirectory = page.file.split('/').length - 1;
      const leavesDocs = [...source.matchAll(/\]\(((?:\.\.\/)+[^):]+)\)/g)]
        .map((match) => match[1]!)
        // `up` is how many `../` the link climbs; the page's own directory depth
        // is how many it has to spend before it leaves `docs/`.
        .filter((link) => (link.match(/\.\.\//g)?.length ?? 0) > fromDirectory);
      expect(leavesDocs, `${page.file} should link outside docs/ absolutely`).toEqual([]);
    }
  });

  it('resolves relative links for pages one directory deep', async () => {
    const files = await buildDocsSite('docs');
    const graphql = files.find((file) => file.path === 'cookbook/graphql.html')!;

    // A page in cookbook/ links back up to the shared stylesheet and FAQ.
    expect(graphql.contents).toContain('href="../style.css"');
    expect(graphql.contents).toContain('href="../faq.html"');
  });

  it('matches the committed site (run `npm run docs:generate`)', async () => {
    for (const file of await buildDocsSite('docs')) {
      const committed = await readFile(join(SITE_DIR, file.path), 'utf8');
      expect(file.contents, `${file.path} is stale`).toBe(committed);
    }
  });
});
