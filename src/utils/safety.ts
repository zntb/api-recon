/** Safety guards evaluated before any browser launches. */

import { isPrivateHost, parseUrl } from './url.js';
import { SafetyError } from './errors.js';

// The error class lives in `errors.ts` alongside the other deliberate types;
// re-exported here so the many `from './safety.js'` imports keep working.
export { SafetyError } from './errors.js';

/**
 * Refuse to scan localhost/private ranges unless explicitly allowed.
 * `force` bypasses robots.txt restrictions only, never the local guard.
 */
export function assertScanAllowed(seedUrl: string, opts: { allowLocal: boolean }): void {
  const parts = parseUrl(seedUrl);
  if (!parts) {
    throw new SafetyError(`Invalid seed URL: ${seedUrl}`, {
      hint: 'Pass a full http(s) URL, e.g. https://example.com.',
    });
  }
  if (!/^https?:$/.test(new URL(seedUrl).protocol)) {
    throw new SafetyError(`Only http(s) URLs can be scanned: ${seedUrl}`, {
      hint: 'Pass a full http(s) URL, e.g. https://example.com.',
    });
  }
  if (isPrivateHost(seedUrl) && !opts.allowLocal) {
    throw new SafetyError(
      `Refusing to scan private/local address ${parts.host} — this usually means a mistake. ` +
        `Pass --allow-local to scan your own machine or a private network host.`,
      { hint: 'Add --allow-local if this target is a machine you own or may test.' },
    );
  }
}
