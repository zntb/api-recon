/**
 * Setup for the browser vitest project (see `vitest.config.ts`). When tracing is
 * on, a failed test points at the directory the CI job uploads, so whoever reads
 * the failure knows a Playwright trace is a click away rather than reproducing
 * the flake locally.
 */

import { beforeEach } from 'vitest';
import { TRACE_DIR, TRACE_ENABLED } from './trace.js';

beforeEach((context) => {
  context.onTestFailed(() => {
    if (!TRACE_ENABLED) return;
    console.error(`[api-recon] test failed — a Playwright trace is under ${TRACE_DIR}`);
  });
});
