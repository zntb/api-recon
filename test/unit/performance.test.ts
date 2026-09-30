import { describe, expect, it } from 'vitest';
import { percentile, summarize } from '../../src/core/performance.js';

describe('percentile', () => {
  it('uses nearest rank, so it never invents a value between observations', () => {
    const ascending = [10, 20, 30, 40];
    // ceil(0.5 * 4) = rank 2 -> index 1.
    expect(percentile(ascending, 50)).toBe(20);
    // ceil(0.95 * 4) = rank 4 -> index 3; not an interpolation.
    expect(percentile(ascending, 95)).toBe(40);
    expect(percentile(ascending, 0)).toBe(10);
    expect(percentile(ascending, 100)).toBe(40);
  });

  it('collapses to the only observation for a single sample', () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
  });

  it('is 0 for no observations', () => {
    expect(percentile([], 50)).toBe(0);
  });
});

describe('summarize', () => {
  it('sorts before ranking and reports p50/p95/max', () => {
    expect(summarize([40, 10, 30, 20])).toEqual({ p50: 20, p95: 40, max: 40 });
  });

  it('reports the single value for all three figures', () => {
    expect(summarize([123])).toEqual({ p50: 123, p95: 123, max: 123 });
  });

  it('returns zeroes for an empty set rather than NaN', () => {
    expect(summarize([])).toEqual({ p50: 0, p95: 0, max: 0 });
  });
});
