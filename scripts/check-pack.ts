/**
 * Published-file-list guard.
 *
 * What `npm publish` uploads is decided by `files` in package.json, and a
 * missing entry there ships a broken package while an extra one can ship a
 * session file, a debug bundle, or the whole source tree. This runs
 * `npm pack --dry-run`, reads the tarball's manifest, and fails if it holds
 * anything outside the expected set or is missing a file the package needs.
 *
 *   npm run check:pack
 *
 * It runs after `npm run build` in CI, because `dist/` has to exist for the
 * assertion to mean anything.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The only top-level entries the published tarball may contain. `package.json`
 * is always included by npm; the rest come from the `files` list.
 */
export const ALLOWED_TOP_LEVEL: readonly string[] = [
  'dist',
  'schema',
  'completions',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'package.json',
];

/** Files that must be present for an installed package to work. */
export const REQUIRED_ENTRIES: readonly string[] = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'schema/report.schema.json',
  'dist/index.js',
  'dist/index.d.ts',
  'dist/cli/index.js',
];

/** One line per problem with a tarball's file list; empty when it is tight. */
export function packViolations(files: readonly string[]): string[] {
  const problems: string[] = [];

  for (const file of files) {
    const top = file.split('/')[0]!;
    if (!ALLOWED_TOP_LEVEL.includes(top)) {
      problems.push(`unexpected entry in the tarball: ${file}`);
    }
  }

  for (const required of REQUIRED_ENTRIES) {
    if (!files.includes(required)) problems.push(`missing from the tarball: ${required}`);
  }

  return problems;
}

/** Read the file list npm would pack. `npm_execpath` keeps it cross-platform. */
export function readPackFiles(): string[] {
  const args = ['pack', '--dry-run', '--json', '--ignore-scripts'];
  const npmCli = process.env.npm_execpath;
  const raw = npmCli
    ? execFileSync(process.execPath, [npmCli, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
        encoding: 'utf8',
        shell: process.platform === 'win32',
        maxBuffer: 64 * 1024 * 1024,
      });

  const parsed = JSON.parse(raw) as Array<{ files?: Array<{ path?: string }> }>;
  return (parsed[0]?.files ?? [])
    .map((entry) => entry.path ?? '')
    .filter((path) => path !== '');
}

function main(): void {
  let files: string[];
  try {
    files = readPackFiles();
  } catch (err) {
    console.error('check-pack: could not run `npm pack --dry-run`.');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const problems = packViolations(files);
  if (problems.length > 0) {
    console.error('\n::error::the published tarball is not the expected file list:\n');
    for (const problem of problems) console.error(`  • ${problem}`);
    console.error(
      '\nAdjust `files` in package.json, or update ALLOWED_TOP_LEVEL in' +
        ' scripts/check-pack.ts if the package legitimately changed.\n',
    );
    process.exit(1);
  }

  console.log(
    `Pack list OK — ${files.length} file(s) from ${ALLOWED_TOP_LEVEL.join(', ')}; nothing else is published.`,
  );
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
