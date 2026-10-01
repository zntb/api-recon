/**
 * The canonical baseline a scan is compared against.
 *
 * Managing a baseline path by hand is what made the CI-gate use case awkward:
 * every job had to remember where the previous `report.json` went, and a
 * renamed output directory silently turned `--diff` into a missing file. The
 * `baseline` subcommand writes a report to a known place instead, and
 * `--diff latest` reads it back, so neither side names a file.
 *
 * The place is `.api-recon/baseline.json`. It is discovered by walking up from
 * the working directory, like the project config file, so a repository that
 * commits one baseline found from any subdirectory is the same baseline. When
 * no file exists yet it defaults to the working directory.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ReconReport } from '../types.js';

/** Directory that holds the baseline, relative to a project directory. */
export const BASELINE_DIR = '.api-recon';

/** File name of the baseline inside {@link BASELINE_DIR}. */
export const BASELINE_FILENAME = 'baseline.json';

/** The sentinel accepted by `--diff` in place of a path. */
export const LATEST = 'latest';

/** True when `--diff` (or a config/env value) asks for the stored baseline. */
export function isLatestBaseline(value: unknown): value is typeof LATEST {
  return typeof value === 'string' && value.trim().toLowerCase() === LATEST;
}

/** The baseline path in `cwd`, whether or not anything is there yet. */
export function defaultBaselinePath(cwd: string = process.cwd()): string {
  return join(resolve(cwd), BASELINE_DIR, BASELINE_FILENAME);
}

/**
 * The nearest existing baseline at or above `startDir`, or null. Walking up
 * means a baseline committed at the repository root is found by a run from a
 * package subdirectory.
 */
export async function findBaseline(startDir: string = process.cwd()): Promise<string | null> {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, BASELINE_DIR, BASELINE_FILENAME);
    if (await isFile(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Where `baseline` writes and `--diff latest` reads: the existing baseline when
 * one is found, so a re-run updates it in place, and otherwise the default path
 * under the working directory.
 */
export async function resolveBaselinePath(cwd: string = process.cwd()): Promise<string> {
  return (await findBaseline(cwd)) ?? defaultBaselinePath(cwd);
}

/** True when a file exists at `filePath` — an explicit `--baseline` target. */
export async function baselineExists(filePath: string): Promise<boolean> {
  return isFile(filePath);
}

/** Write a report as the canonical baseline, creating the directory if needed. */
export async function writeBaseline(report: ReconReport, filePath: string): Promise<string> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
