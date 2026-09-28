/**
 * Probe whether a real Chromium can launch. Browser-driven suites skip with a
 * clear notice when it cannot — e.g. a sandbox without Chromium's shared
 * libraries — while CI (which installs them) runs the full suite.
 */

import { chromium } from 'playwright';

let cached: boolean | null = null;

export async function browserAvailable(): Promise<boolean> {
  if (cached !== null) return cached;
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    cached = true;
  } catch (err) {
    cached = false;
    console.warn(
      '[api-recon tests] Chromium cannot launch, skipping browser-driven tests.\n' +
        '  Install it with: npx playwright install chromium --with-deps\n' +
        `  Reason: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    );
  }
  return cached;
}
