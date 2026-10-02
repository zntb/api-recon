import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';
import { crawl, navigateWithRetry } from '../../src/core/crawler.js';
import { ScanScope } from '../../src/core/scope.js';
import { RateLimiter } from '../../src/utils/rateLimit.js';
import { Logger } from '../../src/utils/logger.js';

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

  it('does not attempt a navigation when the signal is already aborted', async () => {
    const seen: number[] = [];
    const controller = new AbortController();
    controller.abort();
    const { page } = stubPage([null], seen);

    const result = await navigateWithRetry(
      page,
      'https://example.com/',
      1000,
      undefined,
      controller.signal,
    );

    expect(result.attempts).toBe(0);
    expect(seen).toEqual([]);
  });

  it('skips the retry when the signal aborts after the first failure', async () => {
    const seen: number[] = [];
    const controller = new AbortController();
    const { page } = stubPage([new Error('boom')], seen);

    const result = await navigateWithRetry(
      page,
      'https://example.com/',
      1000,
      () => controller.abort(),
      controller.signal,
    );

    expect(result.attempts).toBe(1);
    expect(seen).toEqual([0]);
    expect((result.error as Error).message).toBe('boom');
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

/**
 * A stand-in page whose content carries one same-origin link, so a crawl would
 * normally visit a second page. Every navigation is recorded.
 */
function linkPage(): { page: Page; navigated: string[] } {
  const navigated: string[] = [];
  let current = '';
  const page = {
    async goto(url: string) {
      current = url;
      navigated.push(url);
      return null;
    },
    url: () => current,
    async waitForLoadState() {},
    async waitForTimeout() {},
    async title() {
      return 'Example';
    },
    async content() {
      return '<html><a href="https://example.com/next">next</a></html>';
    },
    async evaluate() {
      return [];
    },
  };
  return { page: page as unknown as Page, navigated };
}

function crawlOptions(overrides: Record<string, unknown> = {}) {
  return {
    seedUrl: 'https://example.com/',
    maxDepth: 2,
    maxPages: 10,
    limiter: new RateLimiter({ delayMs: 0 }),
    robots: null,
    logger: new Logger({ quiet: true }),
    scope: new ScanScope('https://example.com/'),
    ...overrides,
  };
}

describe('crawl cancellation', () => {
  it('walks the frontier when no signal aborts', async () => {
    const { page, navigated } = linkPage();
    const result = await crawl(page, crawlOptions());

    expect(navigated).toHaveLength(2);
    expect(result.pages).toHaveLength(2);
  });

  it('stops at the next page boundary once the signal aborts', async () => {
    const controller = new AbortController();
    const { page, navigated } = linkPage();

    const result = await crawl(
      page,
      crawlOptions({
        signal: controller.signal,
        // Abort after the first page has been recorded: the loop should notice
        // at the next boundary rather than start another navigation.
        onPageVisited: () => controller.abort(),
      }),
    );

    expect(navigated).toHaveLength(1);
    expect(result.pages).toHaveLength(1);
  });

  it('visits nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { page, navigated } = linkPage();

    const result = await crawl(page, crawlOptions({ signal: controller.signal }));

    expect(navigated).toEqual([]);
    expect(result.pages).toEqual([]);
  });
});
