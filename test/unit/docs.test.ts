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
      expect(file.contents, `${file.path} should not link to a .md file`).not.toMatch(
        /href="[^"#]+\.md/,
      );
      // Every page carries the sidebar, so each nav label appears.
      for (const page of DOCS_PAGES) {
        expect(file.contents, `${file.path} should link to ${page.nav}`).toContain(page.nav);
      }
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
