/**
 * Session factory for Chromium, Firefox, and WebKit (Playwright), with
 * storage-state restore and SPA route hooks. Chromium is the default engine;
 * the others are opt-in via `--browser` / the `browser` option.
 */

import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from 'playwright';
import { BROWSER_ENGINES, type BrowserEngine } from '../types.js';
import { SafetyError } from '../utils/safety.js';

/** Playwright launcher for each supported engine. */
const ENGINE_LAUNCHERS: Record<BrowserEngine, BrowserType> = { chromium, firefox, webkit };

/** True when `value` names an engine this tool can drive. */
export function isBrowserEngine(value: string): value is BrowserEngine {
  return (BROWSER_ENGINES as readonly string[]).includes(value);
}

/**
 * Resolve an engine name to a supported engine, defaulting to Chromium and
 * rejecting anything unknown with the list of valid options.
 */
export function resolveEngine(value: string | undefined): BrowserEngine {
  const engine = (value ?? 'chromium').trim().toLowerCase();
  if (!isBrowserEngine(engine)) {
    throw new SafetyError(
      `Unknown browser engine '${value}'. Supported engines: ${BROWSER_ENGINES.join(', ')}.`,
      { hint: `Pass one of: ${BROWSER_ENGINES.join(', ')}.` },
    );
  }
  return engine;
}

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
  /** Engine to launch. Defaults to `chromium`. */
  engine?: BrowserEngine;
  /**
   * Record a Playwright trace. Used by `--debug`: the scan starts it here and
   * stops it into a file only when the scan fails.
   */
  trace?: boolean;
}

export async function launchSession(options: LaunchOptions): Promise<BrowserSession> {
  const engine = options.engine ?? 'chromium';
  const browser = await ENGINE_LAUNCHERS[engine].launch({ headless: options.headless });
  const context = await browser.newContext({
    ...(options.storageState ? { storageState: options.storageState } : {}),
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  });
  if (options.trace) {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  }
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
