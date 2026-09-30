/**
 * Roll up the per-call latency and payload sizes the interceptor already records
 * into a per-endpoint summary.
 *
 * Percentiles use the nearest-rank method: the value at rank `ceil(p/100 * n)`
 * of the ascending observations. That keeps every reported number one that was
 * actually seen — no interpolated p95 that no caller experienced — and makes a
 * single-sample endpoint report that sample for all three figures.
 */

import type { PercentileStats } from '../types.js';

/** The nearest-rank p-th percentile of an ascending array; `p` is 0–100. */
export function percentile(ascending: number[], p: number): number {
  if (ascending.length === 0) return 0;
  const rank = Math.ceil((p / 100) * ascending.length);
  const index = Math.min(ascending.length - 1, Math.max(0, rank - 1));
  return ascending[index]!;
}

/** p50/p95/max of a non-empty set of observations. */
export function summarize(values: number[]): PercentileStats {
  const ascending = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(ascending, 50),
    p95: percentile(ascending, 95),
    max: ascending[ascending.length - 1] ?? 0,
  };
}
