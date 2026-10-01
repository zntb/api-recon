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

// ---- by value --------------------------------------------------------------
//
// The lists above catch a secret that is *labelled* like one. These patterns
// catch one that is not: a JWT pasted into `note`, a base64 blob in `data`, a
// hex digest in `id`, or an email, phone number, or national id in any field at
// all. Matching is deliberately eager — masking a non-secret is harmless, a
// leaked secret is not — but tuned so ordinary words, slugs, and dates survive.

/** A JSON Web Token: three base64url segments, header encoded as `eyJ…`. */
const JWT_RE = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** An email address, matched anywhere in a value. */
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

/** A US SSN shape (`123-45-6789`), matched anywhere in a value. */
const SSN_RE = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/;

/** The same two shapes as a *whole* value, for a non-JSON body. */
const EMAIL_EXACT_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const SSN_EXACT_RE = /^\d{3}[- ]\d{2}[- ]\d{4}$/;

/** A phone number: the usual separators, with at least ten digits. */
const PHONE_RE = /^\+?\d[\d ().-]*\d$/;

/** The alphabets a high-entropy secret is written in: base64, base64url, hex. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

const MIN_SECRET_LENGTH = 20;
const MIN_SECRET_ENTROPY = 3.5;

/** Shannon entropy in bits per character — how random a string looks. */
function entropyPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

function looksLikePhone(value: string): boolean {
  if (!PHONE_RE.test(value)) return false;
  const digits = (value.match(/\d/g) ?? []).length;
  // A date (8 digits) is not a phone number, and a bare run of digits is an id
  // or a timestamp — so require the usual separators and enough digits.
  return digits >= 10 && /[ ().-]/.test(value.slice(1, -1));
}

function looksLikeHighEntropy(value: string): boolean {
  if (value.length < MIN_SECRET_LENGTH) return false;
  if (!BASE64_RE.test(value) && !BASE64URL_RE.test(value)) return false;
  // Require letters *and* digits: that rules out a plain word, a bare number,
  // and a slug, while a base64 or hex secret has both.
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return false;
  return entropyPerChar(value) >= MIN_SECRET_ENTROPY;
}

/** A value that is *entirely* a secret or identifier, with no surrounding prose. */
export function isSensitiveScalar(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return (
    JWT_RE.test(trimmed) ||
    EMAIL_EXACT_RE.test(trimmed) ||
    SSN_EXACT_RE.test(trimmed) ||
    looksLikePhone(trimmed) ||
    looksLikeHighEntropy(trimmed)
  );
}

/**
 * True when a string value looks like a secret or personal data, whatever its
 * key. PII is matched anywhere in the value; a secret must be the whole value.
 */
export function isSensitiveValue(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  return isSensitiveScalar(trimmed) || EMAIL_RE.test(trimmed) || SSN_RE.test(trimmed);
}

/** Redact values of sensitive headers (case-insensitive). Returns a new object. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    // A value that is a secret or PII is masked whatever the header is called,
    // so a token in an unrecognized header does not survive either.
    out[name] = isSensitiveHeader(name) || isSensitiveValue(value) ? REDACTED : value;
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
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    // Not JSON: replace it wholesale only when the body *is* a secret, so an
    // HTML page that merely mentions an address is left intact.
    return isSensitiveScalar(trimmed) ? REDACTED : body;
  }
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

function maskValue(value: unknown, depth: number, sensitive = false): unknown {
  if (depth > 8) return value;
  if (typeof value === 'string') {
    // `sensitive` carries a sensitive key down through an object or array, so
    // `credentials: { token: … }` is masked like a direct `token`; otherwise the
    // value itself decides.
    return sensitive || isSensitiveValue(value) ? REDACTED : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => maskValue(v, depth + 1, sensitive));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskValue(v, depth + 1, sensitive || isSensitiveBodyKey(k));
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
