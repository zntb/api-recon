/** Chromium session factory (Playwright) with storage-state and SPA route hooks. */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

export interface LaunchOptions {
  headless: boolean;
  /** Path to a Playwright storageState.json to restore an authenticated session. */
  storageState?: string | null;
}

export async function launchSession(options: LaunchOptions): Promise<BrowserSession> {
  const browser = await chromium.launch({ headless: options.headless });
  const context = await browser.newContext({
    ...(options.storageState ? { storageState: options.storageState } : {}),
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  });
  await installSpaHooks(context);
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

/**
 * Record SPA route changes (`history.pushState` / `replaceState` / `popstate`)
 * into a page-scoped queue the crawler drains after each page load.
 */
export async function installSpaHooks(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as { __apiReconRoutes?: string[] };
    if (w.__apiReconRoutes) return;
    w.__apiReconRoutes = [];
    const record = () => {
      try {
        w.__apiReconRoutes!.push(location.href);
      } catch {
        /* detached */
      }
    };
    const wrap = <T extends (...args: never[]) => unknown>(fn: T): T =>
      function (this: unknown, ...args: never[]) {
        const result = fn.apply(this, args);
        record();
        return result;
      } as unknown as T;
    try {
      history.pushState = wrap(history.pushState.bind(history));
      history.replaceState = wrap(history.replaceState.bind(history));
      window.addEventListener('popstate', record);
      window.addEventListener('hashchange', record);
    } catch {
      /* ignore */
    }
  });
}

/** Drain and return SPA routes recorded since the previous call. */
export async function drainSpaRoutes(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(() => {
      const w = window as unknown as { __apiReconRoutes?: string[] };
      const routes = w.__apiReconRoutes ?? [];
      w.__apiReconRoutes = [];
      return routes;
    });
  } catch {
    return [];
  }
}
