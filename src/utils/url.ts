/** URL helpers: normalization, same-domain checks, path-pattern inference, private-host detection. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;
const HEX_RE = /^[0-9a-f]{12,}$/i;
/** Base64url-ish opaque ids (mix of alphanumerics, no separators, length 20+). */
const OPAQUE_RE = /^[A-Za-z0-9_-]{20,}$/;

export interface ParsedUrlParts {
  origin: string;
  host: string;
  path: string;
  query: URLSearchParams;
}

export function parseUrl(raw: string): ParsedUrlParts | null {
  try {
    const u = new URL(raw);
    return { origin: u.origin, host: u.host, path: u.pathname, query: u.searchParams };
  } catch {
    return null;
  }
}

/**
 * Normalize a URL for dedup: lowercase host, strip hash, sort query params,
 * drop common cache-buster params. Trailing slash is kept only for root.
 */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  u.hash = '';
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !/^utm_|^fbclid$|^gclid$|^ref$|^ref_src$/i.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  if (u.pathname !== '/' && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  u.host = u.host.toLowerCase();
  return u.toString();
}

/**
 * Convert a concrete URL path into a pattern, replacing id-like segments
 * with `{paramN}` placeholders: /api/orders/42 -> /api/orders/{id}.
 */
export function toUrlPattern(rawUrl: string): string {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const segments = u.pathname.split('/').filter(Boolean);
  const out: string[] = [];
  let idCount = 0;
  for (const seg of segments) {
    if (looksLikeId(seg)) {
      idCount += 1;
      out.push(`{id${idCount > 1 ? idCount : ''}}`);
    } else {
      out.push(seg);
    }
  }
  const pattern = '/' + out.join('/');
  return pattern;
}

export function looksLikeId(segment: string): boolean {
  if (NUMERIC_RE.test(segment)) return true;
  if (UUID_RE.test(segment)) return true;
  if (HEX_RE.test(segment)) return true;
  if (OPAQUE_RE.test(segment) && /\d/.test(segment)) return true;
  return false;
}

export function isSameDomain(a: string, b: string): boolean {
  const ha = parseUrl(a)?.host.toLowerCase();
  const hb = parseUrl(b)?.host.toLowerCase();
  if (!ha || !hb) return false;
  if (ha === hb) return true;
  const ra = stripWww(ha);
  const rb = stripWww(hb);
  return ra === rb;
}

function stripWww(host: string): string {
  return host.replace(/^www\./, '');
}

const PRIVATE_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]', 'host.docker.internal']);

/** True for localhost, loopback, RFC1918 private ranges, and .local/.internal hosts. */
export function isPrivateHost(rawUrlOrHost: string): boolean {
  let host = rawUrlOrHost;
  try {
    host = new URL(rawUrlOrHost).host;
  } catch {
    /* treat input as a bare host */
  }
  host = host.toLowerCase().replace(/:\d+$/, '');
  if (PRIVATE_HOSTS.has(host) || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  const m = /^172\.(\d+)\./.exec(host);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/** Extract same-origin absolute links from an HTML string. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out: string[] = [];
  const re = /<a\s[^>]*href\s*=\s*["']([^"'#\s]+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(new URL(m[1]!, baseUrl).toString());
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
