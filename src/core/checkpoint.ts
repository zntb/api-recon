/**
 * Scan checkpoints.
 *
 * A crawl can stall, crash, or be cancelled (Ctrl+C) partway through, and
 * starting over is the worst part of a long scan. After each page the scan
 * writes everything it takes to continue — the crawl frontier and the pages,
 * calls, sockets, and technology evidence captured so far — into
 * `<out>/checkpoint.json`, and `--resume` reads it back.
 *
 * The file is an intermediate artifact, not a report: it holds redacted
 * capture data and is deleted once a run completes, so only a run that stopped
 * early leaves one behind. It carries a `version` so a checkpoint from an
 * older shape is refused rather than misread.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BrowserEngine, CapturedCall, CapturedWebSocket } from '../types.js';
import { BROWSER_ENGINES } from '../types.js';
import { SafetyError } from '../utils/errors.js';
import type { CrawlState } from './crawler.js';
import type { TechEvidence } from './techStack.js';

export const SCAN_CHECKPOINT_FILENAME = 'checkpoint.json';
export const SCAN_CHECKPOINT_VERSION = 1;

/** Everything needed to continue a scan that stopped partway through. */
export interface ScanCheckpoint extends CrawlState {
  version: number;
  seedUrl: string;
  engine: BrowserEngine;
  /** Epoch ms of the run's original start, so a resumed report spans the whole run. */
  startedAt: number;
  calls: CapturedCall[];
  webSockets: CapturedWebSocket[];
  evidence: TechEvidence[];
}

/** Where a scan's checkpoint lives for a given output directory. */
export function checkpointPath(outDir: string): string {
  return join(outDir, SCAN_CHECKPOINT_FILENAME);
}

/** Write the checkpoint atomically enough for a crash to leave a usable file. */
export async function writeScanCheckpoint(file: string, checkpoint: ScanCheckpoint): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
}

/** Remove a checkpoint once the run it belongs to has finished. */
export async function removeScanCheckpoint(file: string): Promise<void> {
  await rm(file, { force: true });
}

/** Read and validate a checkpoint, naming what is wrong rather than guessing. */
export async function readScanCheckpoint(file: string): Promise<ScanCheckpoint> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new SafetyError(`No checkpoint found at ${file}.`, {
      hint: 'Run without --resume to start a fresh scan, or point --out at the run that stopped.',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SafetyError(
      `Checkpoint ${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { hint: 'Delete the file and start a fresh scan.' },
    );
  }

  return parseScanCheckpoint(parsed, file);
}

function requireArray(source: string, value: unknown, key: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new SafetyError(`Checkpoint ${source} is missing its "${key}" list.`, {
      hint: 'Delete the file and start a fresh scan.',
    });
  }
  return value;
}

/** Validate a parsed checkpoint document, refusing a shape this build cannot read. */
export function parseScanCheckpoint(value: unknown, source = 'checkpoint'): ScanCheckpoint {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafetyError(`Checkpoint ${source} must be a JSON object.`);
  }
  const raw = value as Record<string, unknown>;

  if (raw['version'] !== SCAN_CHECKPOINT_VERSION) {
    throw new SafetyError(
      `Checkpoint ${source} is version ${JSON.stringify(raw['version'])}; ` +
        `this build reads version ${SCAN_CHECKPOINT_VERSION}.`,
      { hint: 'Delete the file and start a fresh scan.' },
    );
  }
  if (typeof raw['seedUrl'] !== 'string' || raw['seedUrl'] === '') {
    throw new SafetyError(`Checkpoint ${source} does not name a seed URL.`);
  }

  const engine = raw['engine'];
  const resolvedEngine: BrowserEngine =
    typeof engine === 'string' && (BROWSER_ENGINES as readonly string[]).includes(engine)
      ? (engine as BrowserEngine)
      : 'chromium';

  const queueRaw = requireArray(source, raw['queue'], 'queue');
  const queue = queueRaw.map((item) => {
    if (item === null || typeof item !== 'object') {
      throw new SafetyError(`Checkpoint ${source} has a malformed queue entry.`);
    }
    const entry = item as Record<string, unknown>;
    const url = entry['url'];
    const depth = entry['depth'];
    if (typeof url !== 'string' || typeof depth !== 'number') {
      throw new SafetyError(`Checkpoint ${source} has a malformed queue entry.`);
    }
    return { url, depth };
  });

  return {
    version: SCAN_CHECKPOINT_VERSION,
    seedUrl: raw['seedUrl'],
    engine: resolvedEngine,
    startedAt: typeof raw['startedAt'] === 'number' ? raw['startedAt'] : Date.now(),
    queue,
    visited: requireArray(source, raw['visited'], 'visited').map(String),
    seenPages: requireArray(source, raw['seenPages'], 'seenPages').map(String),
    pages: requireArray(source, raw['pages'], 'pages') as ScanCheckpoint['pages'],
    blockedByRobots: requireArray(source, raw['blockedByRobots'], 'blockedByRobots').map(String),
    calls: requireArray(source, raw['calls'], 'calls') as CapturedCall[],
    webSockets: requireArray(source, raw['webSockets'], 'webSockets') as CapturedWebSocket[],
    evidence: requireArray(source, raw['evidence'], 'evidence') as TechEvidence[],
  };
}
