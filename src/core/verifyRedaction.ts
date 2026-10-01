/**
 * Prove, rather than assume, that redaction worked: once the report is
 * assembled, walk it for any original value the capture layer removed. A hit
 * means a secret reached a field the redactors never touch — a page URL, a
 * metadata string, an origin — and the caller can warn loudly or refuse to
 * write. The check never prints the secret; only the report paths where it
 * survived.
 */

import type { ReconReport } from '../types.js';
import type { SecretLedger } from '../utils/redactionLedger.js';

/** Paths are capped so a pathological report cannot produce an endless message. */
const MAX_PATHS = 8;

export interface RedactionVerification {
  /** JSON paths (capped) of report fields that still hold a redacted value. */
  paths: string[];
  /** Total number of leaking fields found, before the cap. */
  total: number;
  /** How many distinct redacted values were checked. */
  checked: number;
}

export function verifyRedaction(report: ReconReport, ledger: SecretLedger): RedactionVerification {
  const secrets = ledger.values();
  const paths: string[] = [];
  let total = 0;
  if (secrets.length > 0) {
    const hits: string[] = [];
    walk(report, '', secrets, hits);
    total = hits.length;
    paths.push(...hits.slice(0, MAX_PATHS));
  }
  return { paths, total, checked: secrets.length };
}

function walk(value: unknown, path: string, secrets: string[], hits: string[]): void {
  if (typeof value === 'string') {
    if (secrets.some((secret) => value.includes(secret))) hits.push(path || '(root)');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, secrets, hits));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, path ? `${path}.${key}` : key, secrets, hits);
    }
  }
}
