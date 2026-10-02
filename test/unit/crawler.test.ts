import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { navigateWithRetry } from '../../src/core/crawler.js';

/**
 * A stand-in for a Playwright page whose `goto` plays back a scripted sequence
 * of outcomes, recording how many times it was called.
 */
function stubPage(
  sequence: Array<null | Error>,
  seen: number[],
): { page: Pick<Page, 'goto'>; calls: () => number } {
  let index = 0;
  const page = {
    async goto() {
      seen.push(index);
      const next = sequence[index++];
      if (next instanceof Error) throw next;
      return null;
    },
  };
  return { page: page as unknown as Pick<Page, 'goto'>, calls: () => seen.length };
}

describe('navigateWithRetry', () => {
  it('succeeds on the first try without retrying', async () => {
    const seen: number[] = [];
    const retried: number[] = [];
    const { page } = stubPage([null], seen);

    const result = await navigateWithRetry(page, 'https://example.com/', 1000, (_err, attempt) =>
      retried.push(attempt),
    );

    expect(result).toMatchObject({ attempts: 1, error: null, response: null });
    expect(seen).toEqual([0]);
    expect(retried).toEqual([]);
  });

  it('retries once and succeeds, reporting the retry', async () => {
    const seen: number[] = [];
    const retried: number[] = [];
    const { page } = stubPage([new Error('Navigation timeout'), null], seen);

    const result = await navigateWithRetry(page, 'https://example.com/', 1000, (_err, attempt) =>
      retried.push(attempt),
    );

    expect(result.attempts).toBe(2);
    expect(result.error).toBeNull();
    expect(seen).toEqual([0, 1]);
    expect(retried).toEqual([1]);
  });

  it('gives up after the retry and keeps the last error', async () => {
    const { page } = stubPage([new Error('first'), new Error('second')], []);

    const result = await navigateWithRetry(page, 'https://example.com/', 1000);

    expect(result.attempts).toBe(2);
    expect(result.response).toBeNull();
    expect((result.error as Error).message).toBe('second');
  });

  it('passes the timeout and wait condition through to goto', async () => {
    let received: unknown;
    const page = {
      async goto(_url: string, options: unknown) {
        received = options;
        return null;
      },
    } as unknown as Pick<Page, 'goto'>;

    await navigateWithRetry(page, 'https://example.com/', 1234);

    expect(received).toEqual({ waitUntil: 'load', timeout: 1234 });
  });
});
