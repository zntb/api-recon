/**
 * robots.txt fetching and parsing. Supports User-agent groups, Allow/Disallow,
 * and a light implementation of the "longest match wins" rule used by Google.
 */

import { createHash } from 'node:crypto';

export interface RobotsRules {
  /** Site-wide crawl delay in seconds, if declared for any agent. */
  crawlDelaySeconds: number | null;
  sitemaps: string[];
  /** Raw text for the report. */
  raw: string | null;
}

/** Result of fetching robots.txt: a checker plus the parsed rules. */
export interface RobotsFile {
  isAllowed: (path: string, userAgent?: string) => boolean;
  rules: RobotsRules;
}

interface AgentGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

const CACHE = new Map<string, RobotsFile & { fetchedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Fetch and parse /robots.txt for the given origin. Never throws: on network
 * errors the site is treated as fully allowed (standard practice).
 */
export async function fetchRobots(origin: string, fetchImpl: typeof fetch = fetch): Promise<RobotsFile> {
  const cached = CACHE.get(origin);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const url = new URL('/robots.txt', origin).toString();
  let raw: string | null = null;
  try {
    const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    if (res.ok) raw = await res.text();
  } catch {
    raw = null;
  }

  const parsed = parseRobots(raw);
  const entry = { ...parsed, fetchedAt: Date.now() };
  CACHE.set(origin, entry);
  return parsed;
}

/** Parse robots.txt content into an `isAllowed` checker. Exported for tests. */
export function parseRobots(raw: string | null): RobotsFile {
  if (!raw) {
    return {
      isAllowed: () => true,
      rules: { crawlDelaySeconds: null, sitemaps: [], raw: null },
    };
  }

  const groups: AgentGroup[] = [];
  const sitemaps: string[] = [];
  let crawlDelaySeconds: number | null = null;
  let current: AgentGroup | null = null;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (field === 'user-agent') {
      if (!current || current.allow.length || current.disallow.length) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (!current) continue;

    if (field === 'disallow') {
      if (value) current.disallow.push(value);
      continue;
    }
    if (field === 'allow') {
      if (value) current.allow.push(value);
      continue;
    }
    if (field === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n)) crawlDelaySeconds = Math.max(crawlDelaySeconds ?? 0, n);
      continue;
    }
  }

  const rules: RobotsRules = { crawlDelaySeconds, sitemaps, raw };

  const isAllowed = (path: string, userAgent = '*'): boolean => {
    const pathOnly = path.includes('://') ? new URL(path).pathname : path;
    const ua = userAgent.toLowerCase();

    // Pick the most specific matching group ("*" as fallback).
    let best: AgentGroup | null = null;
    let bestScore = -1;
    for (const g of groups) {
      for (const a of g.agents) {
        const score = a === '*' ? 1 : ua.includes(a) && a.length > 1 ? 10 + a.length : -1;
        if (score > bestScore) {
          bestScore = score;
          best = g;
        }
      }
    }
    if (!best) return true;

    // Longest-match-wins between Allow and Disallow.
    let longest = 0;
    let allowed = true;
    for (const d of best.disallow) {
      if (pathOnly.startsWith(d) && d.length > longest) {
        longest = d.length;
        allowed = false;
      }
    }
    for (const a of best.allow) {
      if (pathOnly.startsWith(a) && a.length >= longest) {
        longest = a.length;
        allowed = true;
      }
    }
    return allowed;
  };

  return { isAllowed, rules };
}

/** Cache key helper used by fetchRobots (exported for tests). */
export function robotsCacheKey(origin: string): string {
  return createHash('sha1').update(origin).digest('hex').slice(0, 12);
}
