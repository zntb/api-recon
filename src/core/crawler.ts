/** Breadth-first crawler over same-domain links, respecting robots and rate limits. */

import type { Page } from 'playwright';
import type { CapturedPage } from '../types.js';
import { drainSpaRoutes } from './browser.js';
import { extractLinks, isSameDomain, normalizeUrl } from '../utils/url.js';
import type { RateLimiter } from '../utils/rateLimit.js';
import type { Logger } from '../utils/logger.js';

export interface RobotsLike {
  isAllowed: (path: string, userAgent?: string) => boolean;
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
  navTimeoutMs?: number;
  settleMs?: number;
}

export interface CrawlOutcome {
  pages: CapturedPage[];
  blockedByRobots: string[];
}

export async function crawl(page: Page, options: CrawlOptions): Promise<CrawlOutcome> {
  const queue: Array<{ url: string; depth: number }> = [{ url: options.seedUrl, depth: 0 }];
  const visited = new Set<string>();
  const seenPages = new Set<string>();
  const pages: CapturedPage[] = [];
  const blockedByRobots: string[] = [];
  const navTimeout = options.navTimeoutMs ?? 30_000;
  const settle = options.settleMs ?? 3_000;

  const recordPage = (url: string, depth: number, title: string | null): void => {
    if (!url) return;
    const normalized = normalizeUrl(url);
    if (seenPages.has(normalized)) return;
    seenPages.add(normalized);
    pages.push({ url, normalizedUrl: normalized, depth, title, visitedAt: Date.now() });
  };

  while (queue.length > 0 && visited.size < options.maxPages) {
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
    try {
      const response = await page.goto(item.url, { waitUntil: 'load', timeout: navTimeout });
      options.logger.debug(`  ${response ? response.status() : 'no response'} ${item.url}`);
      if (response) mainHeaders = response.headers();
    } catch (err) {
      options.logger.warn(
        `could not load ${item.url}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
      );
      recordPage(item.url, item.depth, null);
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
      if (!isSameDomain(route, options.seedUrl)) continue;
      recordPage(route, item.depth + 1, null);
      if (item.depth + 1 <= options.maxDepth && !visited.has(normalizeUrl(route))) {
        queue.push({ url: route, depth: item.depth + 1 });
      }
    }

    if (item.depth < options.maxDepth) {
      for (const link of extractLinks(html, page.url())) {
        if (!isSameDomain(link, options.seedUrl)) continue;
        const linkNormalized = normalizeUrl(link);
        if (visited.has(linkNormalized)) continue;
        queue.push({ url: link, depth: item.depth + 1 });
      }
    }
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
