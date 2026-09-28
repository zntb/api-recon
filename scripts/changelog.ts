/**
 * Extract one version's section from CHANGELOG.md.
 *
 * The release workflow uses this for two things at once:
 *   1. fail fast when a tag has no changelog entry, and
 *   2. publish that entry as the GitHub Release body,
 *
 * so CHANGELOG.md stays the single source of truth for release notes.
 *
 *   tsx scripts/changelog.ts --version 0.2.0
 *   tsx scripts/changelog.ts --version 0.2.0 --out release-notes.md
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export interface ChangelogSection {
  /** The matched heading line, e.g. `## [0.2.0] - 2026-10-01`. */
  heading: string;
  /** Everything under the heading, up to the next version heading. */
  body: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Match the heading for exactly this version, in any of the common forms:
 * `## [0.2.0] - 2026-10-01`, `## [0.2.0]`, `## 0.2.0`, `## v0.2.0`.
 * The trailing lookahead stops `0.1.0` from matching a `0.10.0` heading.
 */
function versionHeading(version: string): RegExp {
  return new RegExp(`^##\\s+\\[?v?${escapeRegExp(version)}\\]?(?=\\s|$)`);
}

/** Extract a version's section, or null when CHANGELOG.md has no such heading. */
export function extractChangelogSection(
  changelog: string,
  version: string,
): ChangelogSection | null {
  const lines = changelog.split(/\r?\n/);
  const heading = versionHeading(version);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) return null;

  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Stop at the next version heading.
    if (/^##\s/.test(line)) break;
    // Stop at the link-reference block at the foot of the file, e.g.
    // `[0.2.0]: https://github.com/.../releases/tag/v0.2.0`
    if (/^\[[^\]]+\]:\s*\S/.test(line)) break;
    body.push(line);
  }

  return { heading: lines[start]!.trim(), body: body.join('\n').trim() };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      version: { type: 'string' },
      file: { type: 'string', default: 'CHANGELOG.md' },
      out: { type: 'string' },
    },
  });

  // Accept `v0.2.0` as well as `0.2.0`, since the tag carries the `v`.
  const version = values.version?.trim().replace(/^v/, '');
  if (!version) {
    console.error('changelog: --version is required, e.g. --version 0.2.0');
    process.exit(2);
  }

  let changelog: string;
  try {
    changelog = await readFile(values.file, 'utf8');
  } catch {
    console.error(`changelog: could not read ${values.file}`);
    process.exit(2);
  }

  const section = extractChangelogSection(changelog, version);
  if (!section || section.body === '') {
    const today = new Date().toISOString().slice(0, 10);
    console.error(`\n::error::${values.file} has no entry for version ${version}.`);
    console.error(`\nAdd one before tagging, for example:\n`);
    console.error(`  ## [${version}] - ${today}\n`);
    console.error('  <a sentence or two on what changed, then ### Added / ### Fixed>\n');
    process.exit(1);
  }

  const notes = `${section.body}\n`;
  if (values.out) {
    await writeFile(values.out, notes, 'utf8');
    console.log(`Wrote release notes for ${version} (${section.heading}) to ${values.out}`);
  } else {
    process.stdout.write(notes);
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) await main();
