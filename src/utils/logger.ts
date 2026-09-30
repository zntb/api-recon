/** Tiny leveled logger with --quiet/--verbose support and secret scrubbing. */

import chalk from 'chalk';
import { redactLogLine } from './redact.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LoggerOptions {
  quiet?: boolean;
  verbose?: boolean;
  /**
   * Where human output goes. `stderr` when stdout is carrying a report to
   * something else — `--print > report.md` must not collect the commentary.
   * Errors and warnings always use stderr.
   */
  stream?: 'stdout' | 'stderr';
}

export class Logger {
  private level: LogLevel;
  private readonly stream: 'stdout' | 'stderr';
  private readonly scrub: (line: string) => string;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.quiet ? 'error' : opts.verbose ? 'debug' : 'info';
    this.stream = opts.stream ?? 'stdout';
    this.scrub = redactLogLine;
  }

  get isVerbose(): boolean {
    return this.level === 'debug';
  }

  private emit(stream: 'log' | 'error', prefix: string, color: (s: string) => string, msg: string): void {
    const line = this.scrub(msg);
    const toStdout = stream === 'log' && this.stream === 'stdout';
    const write = toStdout ? console.log : console.error;
    write(prefix.length ? color(`${prefix} `) + line : line);
  }

  error(msg: string): void {
    this.emit('error', '✗', chalk.red, msg);
  }

  warn(msg: string): void {
    if (this.level === 'error') return;
    this.emit('log', '⚠', chalk.yellow, msg);
  }

  info(msg: string): void {
    if (this.level !== 'info' && this.level !== 'debug') return;
    this.emit('log', '', chalk.white, msg);
  }

  success(msg: string): void {
    if (this.level !== 'info' && this.level !== 'debug') return;
    this.emit('log', '✔', chalk.green, msg);
  }

  debug(msg: string): void {
    if (this.level !== 'debug') return;
    this.emit('log', '·', chalk.gray, msg);
  }

  /** Always printed (acceptable-use banner, final summary). */
  always(msg: string): void {
    this.emit('log', '', chalk.white, msg);
  }
}

export const ACCEPTABLE_USE_BANNER = `
  ┌─────────────────────────────────────────────────────────────┐
  │  api-recon — acceptable use                                 │
  │                                                             │
  │  This tool observes and documents the APIs of sites you     │
  │  are authorized to test. It never bypasses auth, captchas,  │
  │  or bot protections. Respect robots.txt and rate limits,    │
  │  and only scan systems you own or have permission to scan.  │
  └─────────────────────────────────────────────────────────────┘`;
