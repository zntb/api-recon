/**
 * Probe whether a real browser can launch for a given Playwright engine.
 * Browser-driven suites skip with a clear notice when it cannot — e.g. a
 * sandbox without the engine's shared libraries — while CI (which installs all
 * three) runs the full suite.
 *
 * Results are cached per engine, so probing Firefox never re-probes Chromium.
 */

import { chromium, firefox, webkit, type BrowserType } from 'playwright';
import { BROWSER_ENGINES, type BrowserEngine } from '../../src/types.js';

const LAUNCHERS: Record<BrowserEngine, BrowserType> = { chromium, firefox, webkit };
const availability = new Map<BrowserEngine, boolean>();

export async function browserAvailable(engine: BrowserEngine = 'chromium'): Promise<boolean> {
  const known = availability.get(engine);
  if (known !== undefined) return known;

  try {
    const browser = await LAUNCHERS[engine].launch({ headless: true });
    await browser.close();
    availability.set(engine, true);
  } catch (err) {
    availability.set(engine, false);
    console.warn(
      `[api-recon tests] ${engine} cannot launch, skipping browser-driven tests.\n` +
        `  Install it with: npx playwright install ${engine} --with-deps\n` +
        `  Reason: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    );
  }

  return availability.get(engine)!;
}

/** The engines that are not installed here, for a quick skip decision. */
export async function installedEngines(): Promise<BrowserEngine[]> {
  const results = await Promise.all(
    BROWSER_ENGINES.map(async (engine) => ({
      engine,
      ok: await browserAvailable(engine),
    })),
  );
  return results.filter((r) => r.ok).map((r) => r.engine);
}
