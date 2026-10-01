/**
 * Remembers the original values redaction removed during a scan, so the built
 * report can be *proved* clean before it is written. The values are held in
 * memory only — they are never serialized into a report, a log line, or disk.
 */

/**
 * Values shorter than this are too ambiguous to verify: a 3-character password
 * would match a status code or a byte count and cry wolf on a clean report.
 */
const MIN_VERIFIABLE_LENGTH = 6;

export class SecretLedger {
  private readonly secrets = new Set<string>();

  /** Record the original value that redaction replaced with `[REDACTED]`. */
  add(value: string | null | undefined): void {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length < MIN_VERIFIABLE_LENGTH) return;
    this.secrets.add(trimmed);
  }

  /** The distinct values gathered, longest first so the most specific wins. */
  values(): string[] {
    return [...this.secrets].sort((a, b) => b.length - a.length);
  }

  get size(): number {
    return this.secrets.size;
  }
}
