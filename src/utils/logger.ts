/** Tiny leveled logger with --quiet/--verbose support and secret scrubbing. */

import chalk from 'chalk';
import { redactLogLine } from './redact.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export class Logger {
  private level: LogLevel;
  private readonly scrub: (line: string) => string;

  constructor(opts: { quiet?: boolean; verbose?: boolean } = {}) {
    this.level = opts.quiet ? 'error' : opts.verbose ? 'debug' : 'info';
    this.scrub = redactLogLine;
  }

  get isVerbose(): boolean {
    return this.level === 'debug';
  }

  private emit(stream: 'log' | 'error', prefix: string, color: (s: string) => string, msg: string): void {
    const line = this.scrub(msg);
    const write = stream === 'log' ? console.log : console.error;
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
