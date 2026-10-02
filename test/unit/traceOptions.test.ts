import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  delete process.env.API_RECON_TEST_TRACE;
  delete process.env.API_RECON_TRACE_DIR;
  vi.resetModules();
});

describe('traceOptions', () => {
  it('is empty when tracing is off', async () => {
    vi.resetModules();
    const { traceOptions, TRACE_ENABLED } = await import('../helpers/trace.js');

    expect(TRACE_ENABLED).toBe(false);
    expect(traceOptions()).toEqual({});
  });

  it('names a distinct debug directory per call when tracing is on', async () => {
    process.env.API_RECON_TEST_TRACE = '1';
    process.env.API_RECON_TRACE_DIR = join('some', 'traces');
    vi.resetModules();
    const { traceOptions, TRACE_ENABLED } = await import('../helpers/trace.js');

    expect(TRACE_ENABLED).toBe(true);
    expect(traceOptions('scan')).toEqual({
      debug: true,
      debugDir: join('some', 'traces', 'scan-1'),
    });
    // A distinct directory per scan, so two failures never overwrite one trace.
    expect(traceOptions('scan')).toEqual({
      debug: true,
      debugDir: join('some', 'traces', 'scan-2'),
    });
  });
});
