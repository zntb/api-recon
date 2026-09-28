/** Safety guards evaluated before any browser launches. */

import { isPrivateHost, parseUrl } from './url.js';

export class SafetyError extends Error {}

/**
 * Refuse to scan localhost/private ranges unless explicitly allowed.
 * `force` bypasses robots.txt restrictions only, never the local guard.
 */
export function assertScanAllowed(seedUrl: string, opts: { allowLocal: boolean }): void {
  const parts = parseUrl(seedUrl);
  if (!parts) throw new SafetyError(`Invalid seed URL: ${seedUrl}`);
  if (!/^https?:$/.test(new URL(seedUrl).protocol)) {
    throw new SafetyError(`Only http(s) URLs can be scanned: ${seedUrl}`);
  }
  if (isPrivateHost(seedUrl) && !opts.allowLocal) {
    throw new SafetyError(
      `Refusing to scan private/local address ${parts.host} — this usually means a mistake. ` +
        `Pass --allow-local to scan your own machine or a private network host.`,
    );
  }
}
