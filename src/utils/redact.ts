/**
 * Redaction of sensitive data. Runs at capture time (not report time) so that
 * secrets never land in memory-to-disk artifacts in the first place.
 */

export const REDACTED = '[REDACTED]';

/** Header names whose values must never be persisted. */
export const SENSITIVE_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'x-xsrf-token',
] as const;

/**
 * JSON body key fragments whose string values should be masked. Keys are
 * normalized (lowercased, separators removed) so camelCase names such as
 * `accessToken` and `apiKey` are caught too. Over-masking is intentional:
 * a redacted non-secret is harmless, a leaked secret is not.
 */
export const SENSITIVE_BODY_KEYS = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'apikey',
  'authorization',
  'credential',
  'sessionid',
  'creditcard',
  'cardnumber',
  'cvv',
  'ssn',
] as const;

const SENSITIVE_HEADER_SET = new Set<string>(SENSITIVE_HEADERS);

/** True when a body key looks like it holds a secret. */
export function isSensitiveBodyKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_BODY_KEYS.some((fragment) => normalized.includes(fragment));
}

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_SET.has(name.toLowerCase());
}

/** Redact values of sensitive headers (case-insensitive). Returns a new object. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = isSensitiveHeader(name) ? REDACTED : value;
  }
  return out;
}

/**
 * Mask the *values* of sensitive keys inside a JSON-ish body string.
 * Non-JSON or unparseable bodies are returned unchanged. Depth-limited and
 * size-capped to stay cheap on large payloads.
 */
export function redactBody(body: string | null | undefined, maxBytes = 512 * 1024): string | null {
  if (!body) return null;
  if (body.length > maxBytes) return body;
  const trimmed = body.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return body;
  }
  const masked = maskValue(parsed, 0);
  try {
    return JSON.stringify(masked);
  } catch {
    return body;
  }
}

function maskValue(value: unknown, depth: number): unknown {
  if (depth > 8) return value;
  if (Array.isArray(value)) {
    return value.map((v) => maskValue(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveBodyKey(k) && typeof v === 'string' ? REDACTED : maskValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Scrub credentials from a log line: replaces `key=value` and `key: value`
 * pairs for obvious secret env vars and long bearer tokens.
 */
export function redactLogLine(line: string): string {
  return line
    .replace(/(PASS\w*|SECRET\w*|TOKEN\w*|API_?KEY\w*|PASSWORD\w*)=(\S+)/gi, '$1=' + REDACTED)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer ' + REDACTED)
    .replace(/\b([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, 'JWT ' + REDACTED);
}
