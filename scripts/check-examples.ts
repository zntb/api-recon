/**
 * Example-freshness guard.
 *
 * The reports under `examples/output/` are committed, and generation is
 * deterministic (fixed ports and a fixed clock — see `generate-examples.ts`),
 * so regenerating them shows a diff only when the report itself changed. That
 * is what makes a drift check possible: this generates a fresh copy into a
 * temporary directory and compares it to the committed one, failing when a
 * report change was never regenerated.
 *
 * Generating into a temp directory rather than over `examples/output/` keeps
 * the check from clobbering uncommitted local edits, and lets it run in CI with
 * no follow-up `git diff`.
 *
 *   npm run check:examples
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXAMPLES_DIR, generateExamples } from './generate-examples.js';

/** A relative POSIX path mapped to the SHA-256 of its bytes. */
export type ExamplesSnapshot = Record<string, string>;

/**
 * Files under `examples/output/` that are written by hand, not generated, so a
 * fresh generation is not expected to reproduce them.
 */
export const HAND_MAINTAINED_FILES: readonly string[] = ['README.md'];

/** Hash every file under `dir`, keyed by its path relative to `dir`. */
export async function snapshotDirectory(dir: string): Promise<ExamplesSnapshot> {
  const snapshot: ExamplesSnapshot = {};

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const data = await readFile(full);
        const key = relative(dir, full).split('\\').join('/');
        snapshot[key] = createHash('sha256').update(data).digest('hex');
      }
    }
  };

  try {
    await walk(dir);
  } catch {
    // A missing directory is an empty snapshot, so a renamed output dir shows
    // every file as newly generated rather than crashing the check.
  }
  return snapshot;
}

/**
 * One line per difference; empty when the fresh generation matches committed.
 * `ignore` names hand-maintained files that generation never writes.
 */
export function compareSnapshots(
  committed: ExamplesSnapshot,
  fresh: ExamplesSnapshot,
  ignore: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  const ignored = new Set(ignore);

  for (const name of Object.keys(fresh).sort()) {
    if (ignored.has(name)) continue;
    if (!(name in committed)) {
      problems.push(`generated but not committed: ${name}`);
    } else if (committed[name] !== fresh[name]) {
      problems.push(`out of date: ${name}`);
    }
  }
  for (const name of Object.keys(committed).sort()) {
    if (ignored.has(name)) continue;
    if (!(name in fresh)) {
      problems.push(`committed but no longer generated: ${name}`);
    }
  }

  return problems;
}

async function main(): Promise<void> {
  const committedDir = resolve(EXAMPLES_DIR);
  const tempDir = await mkdtemp(join(tmpdir(), 'api-recon-examples-'));

  let problems: string[];
  try {
    const committed = await snapshotDirectory(committedDir);
    await generateExamples(tempDir);
    const fresh = await snapshotDirectory(tempDir);
    problems = compareSnapshots(committed, fresh, HAND_MAINTAINED_FILES);
  } catch (err) {
    console.error('check-examples: could not generate the sample reports.');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error(
      '\n::error::examples/output is stale — a report change was committed without regenerating it:\n',
    );
    for (const problem of problems) console.error(`  • ${problem}`);
    console.error('\nRun `npm run examples:generate` and commit the result.\n');
    process.exit(1);
  }

  console.log('Examples OK — examples/output matches a fresh generation.');
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) await main();
