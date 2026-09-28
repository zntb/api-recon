/**
 * Generate the sample reports in examples/output/.
 *
 * The browser-based capture engine needs Chromium; this script instead drives
 * the fixture server over plain HTTP and feeds the *real* responses through the
 * same analyzer and reporters the tool uses. The API surface, headers, bodies,
 * schemas, and categorization are genuine — only the interception layer is
 * simulated. Regenerate a browser-captured report with the CLI command shown in
 * examples/README.md.
 *
 *   npm run examples:generate
 */

import { startFixtureServer } from '../test/fixtures/server.js';
import { analyzeCalls } from '../src/core/analyzer.js';
import { detectTechnologies, type TechEvidence } from '../src/core/techStack.js';
import { writeReports } from '../src/reporters/index.js';
import { redactBody, redactHeaders } from '../src/utils/redact.js';
import { normalizeUrl } from '../src/utils/url.js';
import { TOOL_VERSION } from '../src/version.js';
import type { CapturedCall, CapturedPage, ReconReport, ReportFormat } from '../src/types.js';

const OUT_DIR = 'examples/output';
const FORMATS: ReportFormat[] = ['json', 'md', 'html', 'openapi'];

function headersOf(res: Response): Record<string, string> {
  return Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
}

function titleOf(html: string): string | null {
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? null;
}

function scriptSrcs(html: string): string[] {
  return [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]!);
}

async function main(): Promise<void> {
  const fixture = await startFixtureServer({ port: 0, thirdPartyPort: 0 });
  const evidence: TechEvidence[] = [];
  const pages = new Map<string, CapturedPage>();
  const calls: CapturedCall[] = [];
  const startedAt = Date.now();

  const recordPage = async (path: string, depth: number, headers: Record<string, string> = {}): Promise<string> => {
    const url = `${fixture.url}${path}`;
    const res = await fetch(url, { headers, redirect: 'manual' });
    const html = await res.text();
    const normalized = normalizeUrl(url);
    pages.set(normalized, { url, normalizedUrl: normalized, depth, title: titleOf(html), visitedAt: Date.now() });
    evidence.push({ url, headers: headersOf(res), html, cookies: [], scripts: scriptSrcs(html) });
    return html;
  };

  const recordCall = async (
    method: string,
    targetUrl: string,
    options: { body?: string; headers?: Record<string, string>; triggeredBy: string },
  ): Promise<Response> => {
    const t0 = Date.now();
    const requestHeaders: Record<string, string> = {
      accept: 'application/json',
      ...(options.headers ?? {}),
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    };
    const res = await fetch(targetUrl, {
      method,
      ...(options.body ? { body: options.body } : {}),
      headers: requestHeaders,
    });
    const text = await res.text();
    const responseHeaders = headersOf(res);
    calls.push({
      method,
      url: normalizeUrl(targetUrl),
      status: res.status,
      mimeType: (responseHeaders['content-type'] ?? '').split(';')[0]!,
      resourceType: 'fetch',
      requestHeaders: redactHeaders({
        accept: requestHeaders['accept'] ?? 'application/json',
        ...(options.headers ?? {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      }),
      requestBodySample: options.body ? redactBody(options.body) : null,
      responseHeaders: redactHeaders(responseHeaders),
      responseBodySample: text || null,
      responseBodyTruncated: false,
      startedAt: t0,
      durationMs: Date.now() - t0,
      triggeredBy: options.triggeredBy,
    });
    return res;
  };

  try {
    // --- pages -------------------------------------------------------------
    await recordPage('/', 0);
    await recordPage('/products', 1);
    await recordPage('/login', 1);
    await recordPage('/about.html', 1);
    await recordPage('/external.html', 1);

    // --- login flow: real POST, real Set-Cookie ----------------------------
    const loginRes = await recordCall('POST', `${fixture.url}/api/login`, {
      body: JSON.stringify({ username: 'demo@example.com', password: 'hunter2' }),
      triggeredBy: `${fixture.url}/login`,
    });
    const setCookies = loginRes.headers.getSetCookie?.() ?? [loginRes.headers.get('set-cookie') ?? ''];
    // Used only for the follow-up authenticated requests; the report stores
    // the redacted header, never these values.
    const cookie = setCookies.map((c) => c.split(';')[0]!).filter(Boolean).join('; ');
    const authed = { cookie };
    await recordPage('/dashboard', 1, authed);
    evidence.push({ url: `${fixture.url}/dashboard`, headers: {}, html: '', cookies: ['connect.sid'], scripts: [] });

    // --- authenticated API calls -------------------------------------------
    await recordCall('GET', `${fixture.url}/api/user`, { headers: authed, triggeredBy: `${fixture.url}/dashboard` });
    await recordCall('GET', `${fixture.url}/api/orders`, { headers: authed, triggeredBy: `${fixture.url}/dashboard` });

    // --- anonymous API calls ------------------------------------------------
    await recordCall('GET', `${fixture.url}/api/products`, { triggeredBy: `${fixture.url}/products` });
    await recordCall('GET', `${fixture.url}/api/products?page=2`, { triggeredBy: `${fixture.url}/products` });
    await recordCall('GET', `${fixture.url}/api/orders/1042`, {
      headers: authed,
      triggeredBy: `${fixture.url}/dashboard`,
    });
    await recordCall('POST', `${fixture.url}/api/search`, {
      body: JSON.stringify({ q: 'widget' }),
      triggeredBy: `${fixture.url}/products`,
    });
    await recordCall('POST', `${fixture.url}/api/collect`, {
      body: JSON.stringify({ event: 'pageview', path: '/products' }),
      triggeredBy: `${fixture.url}/products`,
    });

    // --- third-party calls ---------------------------------------------------
    await recordCall('POST', `${fixture.thirdPartyUrl}/collect`, {
      body: JSON.stringify({ event: 'partner_impression' }),
      triggeredBy: `${fixture.url}/external.html`,
    });
    await recordCall('GET', `${fixture.thirdPartyUrl}/sdk/config.json`, {
      triggeredBy: `${fixture.url}/external.html`,
    });

    const report: ReconReport = {
      meta: {
        seedUrl: fixture.url,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: Date.now() - startedAt,
        pagesVisited: pages.size,
        apiReconVersion: TOOL_VERSION,
      },
      technologies: detectTechnologies(evidence),
      endpoints: analyzeCalls(calls, { seedUrl: fixture.url }),
      pages: [...pages.values()],
      safety: {
        robotsRespected: true,
        robotsSkippedPaths: [`${fixture.url}/admin`],
        rateLimitMs: 100,
        maxBodyBytes: 1024 * 1024,
        allowLocal: true,
        redact: true,
      },
    };

    const files = await writeReports(report, FORMATS, OUT_DIR);
    console.log(`Wrote ${files.length} sample report(s):`);
    for (const file of files) console.log(`  • ${file}`);
    console.log('  (report.pdf is omitted — PDF rendering needs Chromium.)');
  } finally {
    await fixture.close();
  }
}

await main();
