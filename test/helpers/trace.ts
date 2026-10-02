/**
 * A flake budget for the browser suite: when `API_RECON_TEST_TRACE=1` (set by
 * the CI browser job), every scan records a Playwright trace and keeps it only
 * when the scan fails, so a failure can be triaged from an uploaded artifact
 * instead of reproduced locally. Off by default, since tracing slows a scan.
 *
 * The trace is produced by the library's own `--debug` machinery; this module
 * only decides where it goes. `traceOptions()` is empty when tracing is off, so
 * it can be spread into a scan call unconditionally.
 */

import { join } from 'node:path';

/** True when the browser suite should record traces. */
export const TRACE_ENABLED = process.env.API_RECON_TEST_TRACE === '1';

/** Where a failed scan's trace and partial report are kept. */
export const TRACE_DIR = process.env.API_RECON_TRACE_DIR ?? join('test', 'output', 'traces');

let counter = 0;

/** Scan options that turn on the diagnostic bundle, or nothing when tracing is off. */
export function traceOptions(
  label = 'scan',
): Record<string, never> | { debug: true; debugDir: string } {
  if (!TRACE_ENABLED) return {};
  counter += 1;
  return { debug: true, debugDir: join(TRACE_DIR, `${label}-${counter}`) };
}
