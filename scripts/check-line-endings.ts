/**
 * Line-ending guard.
 *
 * `.gitattributes` (`* text=auto eol=lf`) normalizes line endings on `git add`,
 * but it is not a complete defence: a file can still reach the repository with
 * CRLF when normalization is bypassed (`git add --no-normalize`), when an
 * attribute is unset, or when a tool writes bytes directly.
 *
 * This checks the files Git actually tracks — reading both the stored blob
 * (`i/`) and the working tree (`w/`) — and fails if either uses CRLF. Files
 * that `.gitattributes` deliberately marks CRLF (`.bat`/`.cmd`/`.ps1`) or as
 * binary are skipped.
 *
 *   npm run check:line-endings
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface LineEndingOffender {
  path: string;
  /** EOL as stored in the index (the bytes that would be published). */
  indexEol: string;
  /** EOL as found in the working tree. */
  workTreeEol: string;
  /** Raw `git ls-files --eol` attribute column, for the error output. */
  attributes: string;
}

const BAD_EOLS = new Set(['crlf', 'mixed']);

/**
 * Parse `git ls-files --eol` output, whose lines look like:
 *
 *   i/lf    w/lf    attr/text=auto eol=lf <TAB> path/to/file.ts
 *   i/lf    w/crlf  attr/text  eol=crlf   <TAB> script.bat
 *   i/-text w/-text attr/-text            <TAB> logo.png
 */
export function parseEolListing(output: string): LineEndingOffender[] {
  const offenders: LineEndingOffender[] = [];

  for (const rawLine of output.split(/\r?\n/)) {
    if (rawLine.trim() === '') continue;

    const tabIndex = rawLine.indexOf('\t');
    if (tabIndex === -1) continue;

    const meta = rawLine.slice(0, tabIndex).trim();
    const path = rawLine.slice(tabIndex + 1).trim();
    if (!path) continue;

    const tokens = meta.split(/\s+/);
    const indexEol = (tokens.find((t) => t.startsWith('i/')) ?? 'i/unknown').slice(2);
    const workTreeEol = (tokens.find((t) => t.startsWith('w/')) ?? 'w/unknown').slice(2);
    const attributes = tokens
      .filter((t) => !t.startsWith('i/') && !t.startsWith('w/'))
      .join(' ');

    // Honour intentional exceptions declared in .gitattributes.
    if (attributes.includes('eol=crlf')) continue;
    if (attributes.includes('-text') || attributes.includes('binary')) continue;

    if (BAD_EOLS.has(indexEol) || BAD_EOLS.has(workTreeEol)) {
      offenders.push({ path, indexEol, workTreeEol, attributes });
    }
  }

  return offenders;
}

function readTrackedFileEols(): string {
  return execFileSync('git', ['ls-files', '--eol'], { encoding: 'utf8' });
}

function main(): void {
  let listing: string;
  try {
    listing = readTrackedFileEols();
  } catch (err) {
    console.error('check-line-endings: cannot run `git ls-files --eol` — is this a Git checkout?');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const offenders = parseEolListing(listing);

  if (offenders.length > 0) {
    console.error(
      `\n::error::${offenders.length} tracked file(s) use CRLF but .gitattributes requires LF:\n`,
    );
    for (const offender of offenders) {
      console.error(
        `  • ${offender.path}  (index: ${offender.indexEol}, working tree: ${offender.workTreeEol})`,
      );
    }
    console.error('\nFix with:  git add --renormalize .');
    console.error('If a file is meant to be CRLF, add `eol=crlf` for it in .gitattributes.\n');
    process.exit(1);
  }

  console.log('Line endings OK — every tracked text file is LF.');
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
