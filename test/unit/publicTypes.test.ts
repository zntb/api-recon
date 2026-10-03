/**
 * Type-level tests for the public library surface.
 *
 * `ScanOptions`, `ScanHandle`, and the report types are the parts a TypeScript
 * consumer depends on most, and all three are easy to break silently with a
 * refactor: `expectTypeOf` assertions are checked by `tsc` (this file is in
 * `tsconfig.json`'s include), so a widened or narrowed field fails
 * `npm run typecheck` rather than shipping. The runtime `it` blocks keep the
 * file a real test for the runner; the value is in the types.
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  scan,
  SafetyError,
  CancelledError,
  RuntimeError,
  ApiReconError,
  normalizeFormats,
} from '../../src/index.js';
import type {
  ScanOptions,
  ScanHandle,
  ScanResult,
  ScanEvent,
  Endpoint,
  ReconReport,
  ReportFormat,
  ApiReconError as ApiReconErrorType,
} from '../../src/index.js';

describe('public types', () => {
  it('exposes scan() returning a ScanHandle that is a promise and an event iterator', () => {
    // The duality is the documented contract: `await scan(opts)` and
    // `for await (const event of scan(opts))` both work against one scan.
    expectTypeOf(scan).returns.toEqualTypeOf<ScanHandle>();
    expectTypeOf<ScanHandle>().toMatchTypeOf<Promise<ScanResult>>();
    expectTypeOf<ScanHandle>().toHaveProperty('then'); // i.e. a thenable
    expectTypeOf<ScanHandle[typeof Symbol.asyncIterator]>().returns.toEqualTypeOf<
      AsyncIterator<ScanEvent>
    >();
  });

  it('pins the ScanOptions fields a consumer sets', () => {
    expectTypeOf<ScanOptions>().toHaveProperty('url');
    expectTypeOf<ScanOptions['url']>().toEqualTypeOf<string>();
    expectTypeOf<ScanOptions['depth']>().toEqualTypeOf<number | undefined>();
    expectTypeOf<ScanOptions['formats']>().toEqualTypeOf<ReportFormat[] | undefined>();
    // A signal is what makes the OS-independent teardown path reachable.
    expectTypeOf<ScanOptions['signal']>().toEqualTypeOf<AbortSignal | undefined>();
    // `url` is required; omitting it is a compile error, not a runtime one.
    // @ts-expect-error — `url` is required.
    const missingUrl: ScanOptions = { depth: 1 };
    expect(missingUrl).toBeDefined();
  });

  it('pins the report shape a consumer reads', () => {
    expectTypeOf<ReconReport>().toHaveProperty('schemaVersion');
    expectTypeOf<ReconReport['schemaVersion']>().toEqualTypeOf<number>();
    expectTypeOf<ReconReport['endpoints']>().toEqualTypeOf<Endpoint[]>();
    expectTypeOf<Endpoint['id']>().toEqualTypeOf<string>();
    expectTypeOf<Endpoint['method']>().toEqualTypeOf<string>();
    expectTypeOf<Endpoint['urlPattern']>().toEqualTypeOf<string>();
  });

  it('exposes typed errors carrying an optional hint', () => {
    expectTypeOf<SafetyError>().toMatchTypeOf<ApiReconErrorType>();
    expectTypeOf<CancelledError>().toMatchTypeOf<ApiReconErrorType>();
    expectTypeOf<RuntimeError>().toMatchTypeOf<ApiReconErrorType>();
    expectTypeOf<ApiReconError>().toHaveProperty('hint');
    expectTypeOf<ApiReconError['hint']>().toEqualTypeOf<string | undefined>();
  });

  it('narrows normalizeFormats to known formats', () => {
    expectTypeOf(normalizeFormats).returns.toEqualTypeOf<ReportFormat[]>();
    expect(normalizeFormats(['json', 'md'])).toContain('json');
  });
});
