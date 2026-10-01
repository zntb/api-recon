/**
 * The artifacts a `--debug` scan leaves behind, attached to the error that
 * stopped it so the CLI can finish the bundle.
 *
 * The scan writes the Playwright trace and the partial report itself, before it
 * tears the browser down; it hands their paths to the CLI through the thrown
 * error. A `WeakMap` keeps that out of the error's own shape, so an error is
 * still an ordinary error when a library caller rethrows it.
 */

export interface ScanDebugInfo {
  /** Directory the artifacts were written to. */
  dir: string;
  /** Path to the Playwright trace archive, when a browser ran. */
  trace?: string;
  /** Path to the report built from whatever was captured before the failure. */
  partialReport?: string;
}

const DEBUG_INFO = new WeakMap<object, ScanDebugInfo>();

/** Attach debug artifacts to an error, when it is an object. */
export function attachDebugInfo(error: unknown, info: ScanDebugInfo): void {
  if (error && typeof error === 'object') DEBUG_INFO.set(error as object, info);
}

/** The debug artifacts attached to an error, if any. */
export function debugInfoFor(error: unknown): ScanDebugInfo | undefined {
  return error && typeof error === 'object' ? DEBUG_INFO.get(error as object) : undefined;
}
