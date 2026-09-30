/**
 * Live scan progress.
 *
 * A scan is slow enough that "Scanning …" followed by silence reads as a hang,
 * and a CI log wants the same information as data rather than as a spinner. So
 * the reporter has three modes:
 *
 *   tty    a running table — pages visited and endpoints found so far — redrawn
 *          in place with ANSI cursor movement, so it never scrolls the terminal
 *   json   one JSON object per line on stdout, for a machine to read
 *   none   nothing at all (not a terminal, or `--quiet`)
 *
 * Drawing is separated from scheduling: `buildSnapshot` and the two formatters
 * are pure, and `LiveProgress` only owns the timer and the cursor.
 */

import chalk from 'chalk';
import type { ScanProgressState } from '../types.js';
import { truncate } from './misc.js';
import { toUrlPattern } from './url.js';

export type ProgressMode = 'tty' | 'json' | 'none';

/** Everything a renderer needs, with nothing of the scan's internals in it. */
export interface ProgressSnapshot {
  phase: string;
  seedLabel: string;
  elapsedMs: number;
  pagesVisited: number;
  maxPages: number;
  calls: number;
  endpoints: number;
  currentPage: string | null;
  recentPages: { label: string; depth: number }[];
  recentEndpoints: string[];
}

/** The slice of a writable stream this module uses; a test can pass an array. */
export interface ProgressStream {
  isTTY?: boolean;
  columns?: number;
  write: (chunk: string) => unknown;
}

export interface ProgressOptions {
  /** Defaults to a table on a TTY, and nothing otherwise. */
  mode?: ProgressMode;
  stream?: ProgressStream;
  /** Injectable clock, for the elapsed time and the redraw throttle. */
  now?: () => number;
  /** Redraw interval. A crawl is slow; anything faster is flicker. */
  intervalMs?: number;
  /** Rows kept in each list. Fixed, so a redraw never leaves stragglers behind. */
  rows?: number;
}

/**
 * Which mode a run should use. `--json-progress` is an explicit request for
 * machine output and wins over `--quiet`; otherwise a *terminal* gets the table
 * and anything else (a pipe, a log file, CI) gets nothing, because redrawing
 * ANSI frames into a file helps nobody.
 */
export function progressModeFor(options: {
  json?: boolean;
  quiet?: boolean;
  stream?: ProgressStream;
}): ProgressMode {
  if (options.json) return 'json';
  if (options.quiet) return 'none';
  const stream = options.stream ?? process.stdout;
  return stream.isTTY ? 'tty' : 'none';
}

/** Condense a scan's state into what the table and the JSON line both show. */
export function buildSnapshot(
  state: ScanProgressState,
  options: { now: number; rows?: number },
): ProgressSnapshot {
  const rows = options.rows ?? 3;
  const endpoints: string[] = [];
  const seen = new Set<string>();
  for (const call of state.calls) {
    let pattern: string;
    try {
      pattern = toUrlPattern(call.url);
    } catch {
      pattern = call.url;
    }
    const id = `${call.method} ${pattern}`;
    if (seen.has(id)) continue;
    seen.add(id);
    endpoints.push(id);
  }

  return {
    phase: state.phase,
    seedLabel: hostOf(state.seedUrl),
    elapsedMs: Math.max(0, options.now - state.startedAt),
    pagesVisited: state.pages.length,
    maxPages: state.maxPages,
    calls: state.calls.length,
    endpoints: endpoints.length,
    currentPage: state.pages.length > 0 ? pageLabel(state.pages[state.pages.length - 1]!.url) : null,
    recentPages: state.pages
      .slice(-rows)
      .reverse()
      .map((page) => ({ label: pageLabel(page.url), depth: page.depth })),
    recentEndpoints: endpoints.slice(-rows).reverse(),
  };
}

/**
 * The table, always the same number of lines: the cursor is moved up by that
 * count to redraw, so a varying height would smear the block across the screen.
 */
export function formatProgressTable(
  snapshot: ProgressSnapshot,
  options: { rows?: number; columns?: number } = {},
): string {
  const rows = options.rows ?? 3;
  const columns = options.columns ?? 80;
  const fit = (text: string): string => truncate(text, Math.max(20, columns - 2));

  const lines: string[] = [
    chalk.bold(
      fit(
        `  api-recon · ${snapshot.phase} · ${snapshot.seedLabel} · ${formatElapsed(snapshot.elapsedMs)}`,
      ),
    ),
    fit(
      `  pages ${snapshot.pagesVisited}/${snapshot.maxPages}   ` +
        `requests ${snapshot.calls}   endpoints ${snapshot.endpoints}`,
    ),
    chalk.dim(`  ${'─'.repeat(Math.max(10, Math.min(columns - 4, 60)))}`),
    chalk.dim('  last pages'),
  ];

  for (let i = 0; i < rows; i += 1) {
    const page = snapshot.recentPages[i];
    lines.push(
      page ? fit(`    ${page.label}${page.depth > 0 ? `  (depth ${page.depth})` : ''}`) : '',
    );
  }

  lines.push(chalk.dim('  endpoints found'));
  for (let i = 0; i < rows; i += 1) {
    const endpoint = snapshot.recentEndpoints[i];
    lines.push(endpoint ? fit(`    ${endpoint}`) : '');
  }

  return lines.join('\n');
}

/**
 * One line of JSON per event, so a consumer can read it with `readline` or
 * `jq` without parsing a table. `event` is `progress` while running and `done`
 * on the last update.
 */
export function formatProgressEvent(snapshot: ProgressSnapshot, event = 'progress'): string {
  return JSON.stringify({
    event,
    phase: snapshot.phase,
    elapsedMs: snapshot.elapsedMs,
    pagesVisited: snapshot.pagesVisited,
    maxPages: snapshot.maxPages,
    calls: snapshot.calls,
    endpoints: snapshot.endpoints,
    currentPage: snapshot.currentPage,
  });
}

/** `2.4s`, `1m 03s` — short enough for a header line. */
function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pageLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    return url;
  }
}

/**
 * Owns the timer and the cursor: the scan pushes a state, this decides when to
 * paint and what to do with the lines already on screen.
 */
export class LiveProgress {
  readonly mode: ProgressMode;
  private readonly stream: ProgressStream;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly rows: number;
  private state: ScanProgressState | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private renderedLines = 0;
  private lastPaintAt = 0;

  constructor(options: ProgressOptions = {}) {
    this.stream = options.stream ?? process.stdout;
    this.mode = options.mode ?? (this.stream.isTTY ? 'tty' : 'none');
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 250;
    this.rows = options.rows ?? 3;
  }

  /**
   * Feed the scan's latest state. Redraws are throttled to `intervalMs` — a
   * frame per captured call would flicker — but a phase change is rare and worth
   * showing at once, so it paints immediately.
   */
  render(state: ScanProgressState): void {
    const phaseChanged = this.state !== null && this.state.phase !== state.phase;
    this.state = state;
    this.startTicker();
    this.paint(phaseChanged);
  }

  /** Stop painting, and hand the terminal back clean for the summary. */
  stop(): void {
    this.clearTicker();
    if (this.state) {
      if (this.mode === 'json') this.write(`${formatProgressEvent(this.snapshot(), 'done')}\n`);
      else if (this.mode === 'tty') this.clearBlock();
    }
    this.state = null;
  }

  private snapshot(): ProgressSnapshot {
    return buildSnapshot(this.state!, { now: this.now(), rows: this.rows });
  }

  private startTicker(): void {
    if (this.timer || this.mode === 'none') return;
    this.timer = setInterval(() => this.paint(true), this.intervalMs);
    // Never hold the process open for a progress bar.
    this.timer.unref?.();
  }

  private clearTicker(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private paint(force = false): void {
    if (!this.state || this.mode === 'none') return;
    const at = this.now();
    if (!force && at - this.lastPaintAt < this.intervalMs) return;
    this.lastPaintAt = at;

    const snapshot = this.snapshot();
    if (this.mode === 'json') {
      this.write(`${formatProgressEvent(snapshot)}\n`);
      return;
    }
    this.drawTable(formatProgressTable(snapshot, { rows: this.rows, columns: this.stream.columns ?? 80 }));
  }

  /** Redraw the block in place: up to its first line, clear each, rewrite. */
  private drawTable(frame: string): void {
    const lines = frame.split('\n');
    if (this.renderedLines > 0) this.write(`\u001b[${this.renderedLines}A`);
    for (const line of lines) this.write(`\u001b[2K${line}\n`);
    this.renderedLines = lines.length;
  }

  /** Erase the block and leave the cursor where it started, for the summary. */
  private clearBlock(): void {
    if (this.renderedLines === 0) return;
    this.write(`\u001b[${this.renderedLines}A`);
    for (let i = 0; i < this.renderedLines; i += 1) this.write('\u001b[2K\n');
    this.write(`\u001b[${this.renderedLines}A`);
    this.renderedLines = 0;
  }

  private write(chunk: string): void {
    if (this.mode === 'none') return;
    this.stream.write(chunk);
  }
}
