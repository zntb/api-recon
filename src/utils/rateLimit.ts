/**
 * Per-origin rate limiting. Simple sliding-window "minimum delay between
 * requests to the same origin" with optional fake-clock injection for tests.
 */

export interface RateLimiterOptions {
  /** Minimum delay between requests to the same origin, in ms. */
  delayMs: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class RateLimiter {
  private readonly lastHit = new Map<string, number>();
  private readonly delayMs: number;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: RateLimiterOptions) {
    this.delayMs = Math.max(0, options.delayMs);
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Wait until at least `delayMs` has elapsed since the last call for this origin. */
  async acquire(origin: string): Promise<void> {
    if (this.delayMs === 0) return;
    const last = this.lastHit.get(origin);
    const t = this.now();
    if (last !== undefined) {
      const wait = this.delayMs - (t - last);
      if (wait > 0) await this.sleepImpl(wait);
    }
    this.lastHit.set(origin, this.now());
  }

  /** For tests: current pending wait for an origin (without sleeping). */
  pendingWait(origin: string): number {
    const last = this.lastHit.get(origin);
    if (last === undefined || this.delayMs === 0) return 0;
    return Math.max(0, this.delayMs - (this.now() - last));
  }
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
