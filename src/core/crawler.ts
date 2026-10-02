/** Breadth-first crawler over same-domain links, respecting robots and rate limits. */

import type { Page, Response } from 'playwright';
import type { CapturedPage } from '../types.js';
import { drainSpaRoutes } from './browser.js';
import { extractLinks, normalizeUrl } from '../utils/url.js';
import type { RateLimiter } from '../utils/rateLimit.js';
import type { Logger } from '../utils/logger.js';
import type { ScanScope } from './scope.js';

export interface RobotsLike {
  isAllowed: (path: string, userAgent?: string) => boolean;
}

/**
 * Everything a crawl needs to continue: the frontier still to visit, the URLs
 * already seen, and the pages recorded so far. A scan serializes this into a
 * checkpoint after each page so a crashed run can resume where it stopped.
 */
export interface CrawlState {
  queue: Array<{ url: string; depth: number }>;
  /** Normalized URLs already visited. */
  visited: string[];
  /** Normalized URLs already recorded as pages. */
  seenPages: string[];
  pages: CapturedPage[];
  blockedByRobots: string[];
}

export interface CrawlOptions {
  seedUrl: string;
  maxDepth: number;
  maxPages: number;
  limiter: RateLimiter;
  /** null when robots handling is disabled. */
  robots: RobotsLike | null;
  logger: Logger;
  onPageLoaded?: (
    page: Page,
    html: string,
    depth: number,
    headers: Record<string, string>,
  ) => Promise<void> | void;
  runActions?: (page: Page) => Promise<void>;
  /** Hosts and paths the crawl may follow; also guards redirect destinations. */
  scope: ScanScope;
  /** Fired for every page recorded, including SPA routes discovered in place. */
  onPageVisited?: (page: CapturedPage) => void;
  /**
   * Called after each page with the crawl's state, so the scan can write a
   * checkpoint. Failures are the callback's to handle; the crawl keeps going.
   */
  onCheckpoint?: (state: CrawlState) => Promise<void> | void;
  /** State from a checkpoint, to continue a previous crawl instead of starting over. */
  initial?: CrawlState;
  /** Per-navigation timeout, in milliseconds. */
  navTimeoutMs?: number;
  settleMs?: number;
  /**
   * Stops the crawl between pages when it aborts. The scan sets this from the
   * caller's `AbortSignal`, so a `SIGINT` ends the run at the next boundary
   * rather than mid-navigation.
   */
  signal?: AbortSignal;
}

export interface CrawlOutcome {
  pages: CapturedPage[];
  blockedByRobots: string[];
}

export interface NavigateOutcome {
  response: Response | null;
  /** The last error, or null when a navigation succeeded. */
  error: unknown;
  attempts: number;
}

/**
 * Navigate once, and retry once on failure — a flaky load must not drop a
 * page. A navigation that returns no response (a same-document navigation, for
 * example) is still a success; only a thrown error is retried. Errors are
 * returned rather than thrown so the caller can record the page and move on.
 */
export async function navigateWithRetry(
  page: Pick<Page, 'goto'>,
  url: string,
  timeoutMs: number,
  onRetry?: (error: unknown, attempt: number) => void,
  signal?: AbortSignal,
): Promise<NavigateOutcome> {
  let lastError: unknown = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    // An aborted run must not spend another navigation on a retry; hand the
    // caller the last error (or none) and let it stop.
    if (signal?.aborted) break;
    attempts = attempt;
    try {
      const response = await page.goto(url, { waitUntil: 'load', timeout: timeoutMs });
      return { response, error: null, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt === 1 && !signal?.aborted) onRetry?.(error, attempt);
    }
  }
  return { response: null, error: lastError, attempts };
}

/** The first line of an error, so a warning stays one line. */
function firstLine(err: unknown): string {
  if (err instanceof Error) return err.message.split('\n')[0] ?? err.message;
  return String(err);
}

export async function crawl(page: Page, options: CrawlOptions): Promise<CrawlOutcome> {
  const queue: Array<{ url: string; depth: number }> = options.initial
    ? options.initial.queue.map((item) => ({ ...item }))
    : [{ url: options.seedUrl, depth: 0 }];
  const visited = new Set<string>(options.initial?.visited ?? []);
  const seenPages = new Set<string>(options.initial?.seenPages ?? []);
  const pages: CapturedPage[] = options.initial ? [...options.initial.pages] : [];
  const blockedByRobots: string[] = options.initial ? [...options.initial.blockedByRobots] : [];
  const navTimeout = options.navTimeoutMs ?? 30_000;
  const settle = options.settleMs ?? 3_000;

  const snapshot = (): CrawlState => ({
    queue: queue.map((item) => ({ ...item })),
    visited: [...visited],
    seenPages: [...seenPages],
    pages: [...pages],
    blockedByRobots: [...blockedByRobots],
  });

  // A checkpoint is a convenience, never a reason to stop crawling: a write
  // failure is a warning.
  const checkpoint = async (): Promise<void> => {
    if (!options.onCheckpoint) return;
    try {
      await options.onCheckpoint(snapshot());
    } catch (err) {
      options.logger.warn(`could not write the checkpoint: ${firstLine(err)}`);
    }
  };

  const recordPage = (url: string, depth: number, title: string | null): void => {
    if (!url) return;
    const normalized = normalizeUrl(url);
    if (seenPages.has(normalized)) return;
    seenPages.add(normalized);
    const entry: CapturedPage = {
      url,
      normalizedUrl: normalized,
      depth,
      title,
      visitedAt: Date.now(),
    };
    pages.push(entry);
    options.onPageVisited?.(entry);
  };

  while (queue.length > 0 && visited.size < options.maxPages) {
    // A cancellation lands on a page boundary: finish nothing new, just stop,
    // so the scan can tear the browser down and flush what it has.
    if (options.signal?.aborted) break;

    const item = queue.shift()!;
    const normalized = normalizeUrl(item.url);
    if (visited.has(normalized)) continue;

    if (options.robots) {
      let allowed = true;
      try {
        allowed = options.robots.isAllowed(new URL(item.url).pathname);
      } catch {
        allowed = true;
      }
      if (!allowed) {
        blockedByRobots.push(item.url);
        options.logger.debug(`robots.txt disallows ${item.url} — skipped`);
        continue;
      }
    }

    visited.add(normalized);
    const origin = safeOrigin(item.url);
    await options.limiter.acquire(origin);

    options.logger.debug(`→ ${item.url} (depth ${item.depth})`);
    let html = '';
    let mainHeaders: Record<string, string> = {};

    const nav = await navigateWithRetry(
      page,
      item.url,
      navTimeout,
      (err, attempt) => {
        options.logger.warn(
          `retrying ${item.url} after a failed load (attempt ${attempt + 1} of 2): ${firstLine(err)}`,
        );
      },
      options.signal,
    );

    // The navigation may have failed only because a cancellation closed the
    // browser underneath it; that is a stop, not a page to record as broken.
    if (options.signal?.aborted) break;

    if (nav.error !== null) {
      options.logger.warn(`could not load ${item.url}: ${firstLine(nav.error)}`);
      recordPage(item.url, item.depth, null);
      await checkpoint();
      continue;
    }
    if (nav.response) {
      options.logger.debug(`  ${nav.response.status()} ${item.url}`);
      mainHeaders = nav.response.headers();
    }

    // Playwright follows redirects automatically, so the destination is only
    // visible afterwards. Refuse to process one that left the agreed scope —
    // the page already loaded, but none of it is recorded or inspected.
    const landed = page.url();
    if (landed && !options.scope.allows(landed)) {
      options.logger.warn(
        `refusing cross-origin redirect from ${item.url} to ${landed}` +
          (options.scope.allowsHost(landed)
            ? ' (its path is excluded)'
            : ` — add --include-host ${safeHostname(landed)} to allow it`),
      );
      await checkpoint();
      continue;
    }

    // Let late XHR/fetch traffic arrive before moving on.
    await page.waitForLoadState('networkidle', { timeout: settle }).catch(() => {});
    await page.waitForTimeout(250);

    const title = await page.title().catch(() => null);
    html = await page.content().catch(() => '');
    recordPage(page.url(), item.depth, title);
    if (options.onPageLoaded) await options.onPageLoaded(page, html, item.depth, mainHeaders);

    if (options.runActions) {
      await options.runActions(page);
      await page.waitForLoadState('networkidle', { timeout: settle }).catch(() => {});
      await page.waitForTimeout(200);
      html = await page.content().catch(() => html);
    }

    // SPA route changes observed while on this page.
    for (const route of await drainSpaRoutes(page)) {
      if (!options.scope.allows(route)) continue;
      recordPage(route, item.depth + 1, null);
      if (item.depth + 1 <= options.maxDepth && !visited.has(normalizeUrl(route))) {
        queue.push({ url: route, depth: item.depth + 1 });
      }
    }

    if (item.depth < options.maxDepth) {
      for (const link of extractLinks(html, page.url())) {
        if (!options.scope.allows(link)) continue;
        const linkNormalized = normalizeUrl(link);
        if (visited.has(linkNormalized)) continue;
        queue.push({ url: link, depth: item.depth + 1 });
      }
    }

    await checkpoint();
  }

  return { pages, blockedByRobots };
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
