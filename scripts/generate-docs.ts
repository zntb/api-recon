/**
 * Regenerate the static documentation site under `docs-site/` from `docs/`.
 *
 * The site is committed so it can be served (or opened from `file://`) without a
 * build, and `test/unit/docs.test.ts` fails when the committed pages drift from
 * the Markdown sources.
 *
 *   npm run docs:generate
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildDocsSite } from '../src/docs/site.js';

const DOCS_DIR = 'docs';
const OUT_DIR = 'docs-site';

for (const file of await buildDocsSite(DOCS_DIR)) {
  const target = join(OUT_DIR, file.path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, file.contents, 'utf8');
  console.log(`Wrote ${target}`);
}
