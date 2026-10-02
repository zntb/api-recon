/**
 * The error types api-recon raises on purpose.
 *
 * The distinction the CLI acts on is *why* a run stopped. A `SafetyError` is a
 * guard refusing to start — scanning localhost without permission, robots.txt,
 * a config file that would loosen safety — and exits `2`. A `RuntimeError` is a
 * scan that started and then failed, and exits `1`. A crash that is neither (a
 * Playwright bug, an out-of-memory) is left as-is and also exits `1`.
 *
 * Every deliberate error can carry a `hint`: one short line naming the next
 * step. The CLI prints it under the message, so a failure ends in what to try
 * rather than only what went wrong.
 */

export interface ApiReconErrorOptions {
  /** A short "what to try next" line, printed under the message. */
  hint?: string;
  cause?: unknown;
}

export class ApiReconError extends Error {
  readonly hint?: string;

  constructor(message: string, options: ApiReconErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    if (options.hint) this.hint = options.hint;
  }
}

/** A guard refused to run: a safety refusal or an invalid option. */
export class SafetyError extends ApiReconError {}

/** A scan started but failed before it could produce a report. */
export class RuntimeError extends ApiReconError {}

/**
 * A scan stopped early on request — a `SIGINT`/`SIGTERM` or an `AbortSignal` —
 * rather than on its own. It is a deliberate stop, not a failure: whatever was
 * captured is flushed first, so the try/catch around a scan can tell this apart
 * from a real error and choose a different exit code.
 */
export class CancelledError extends ApiReconError {}

/**
 * The hint to print after an error: the error's own when it has one, and
 * otherwise a default matched to its class, so every failure ends in a next
 * step.
 */
export function hintForError(err: unknown): string {
  if (err instanceof ApiReconError && err.hint) return err.hint;
  if (err instanceof CancelledError) {
    return 'The run stopped where it was asked to; a partial report.json was kept.';
  }
  if (err instanceof SafetyError) {
    return 'Check the option or value named above, and run with --verbose for more detail.';
  }
  return (
    'Re-run with --debug to write a diagnostic bundle (logs, browser trace, and ' +
    'a partial report) for a bug report.'
  );
}
