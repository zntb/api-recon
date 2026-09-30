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
 * Because the output is committed, generation is deterministic: the servers
 * bind fixed ports and every timestamp comes from a fixed clock. Regenerating
 * therefore shows a diff only when the report itself changed, rather than
 * rewriting every origin and timestamp on each run.
 *
 *   npm run examples:generate
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startFixtureServer } from '../test/fixtures/server.js';
import { analyzeCalls, analyzeWebSockets } from '../src/core/analyzer.js';
import { groupResources } from '../src/core/resources.js';
import { inferSchemaFromFrames } from '../src/core/schemaInference.js';
import { diffReports } from '../src/core/diff.js';
import { collectFindings } from '../src/core/findings.js';
import { detectTechnologies, type TechEvidence } from '../src/core/techStack.js';
import { renderDashboard } from '../src/reporters/dashboard.js';
import { writeReports } from '../src/reporters/index.js';
import { redactBody, redactHeaders } from '../src/utils/redact.js';
import { normalizeUrl } from '../src/utils/url.js';
import { TOOL_VERSION } from '../src/version.js';
import { REPORT_SCHEMA_VERSION } from '../src/types.js';
import type {
  CapturedCall,
  CapturedPage,
  CapturedWebSocket,
  Endpoint,
  ReconReport,
  ReportFormat,
  WebSocketFrame,
} from '../src/types.js';

const OUT_DIR = 'examples/output';
const FORMATS: ReportFormat[] = ['json', 'md', 'html', 'openapi', 'dashboard'];

// Fixed ports and a fixed clock keep the committed examples reproducible. The
// ephemeral ports the tests use, and the wall clock, would otherwise rewrite
// every origin and timestamp on each run and bury a real change in the diff.
const EXAMPLE_PORT = 4610;
const EXAMPLE_THIRD_PARTY_PORT = 4611;
const CLOCK_START = Date.parse('2026-01-01T00:00:00.000Z');
const CLOCK_STEP_MS = 7;
let clockMs = CLOCK_START;

/** A deterministic stand-in for `Date.now()`: the same value on every run. */
function now(): number {
  const at = clockMs;
  clockMs += CLOCK_STEP_MS;
  return at;
}

// Ids the simulated previous scan is built around. Named rather than positional
// so the diff example stays readable, and checked below so it cannot quietly
// stop demonstrating one of the three change kinds.
const PREVIOUS_NEW_ID = 'POST /api/search';
const PREVIOUS_CHANGED_ID = 'GET /api/products';

function headersOf(res: Response): Record<string, string> {
  const headers = Object.fromEntries(
    [...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]),
  );
  // The server stamps the current time on every response; pin it so the
  // committed example stays reproducible.
  if ('date' in headers) headers['date'] = new Date(CLOCK_START).toUTCString();
  return headers;
}

/**
 * Connect to the fixture's socket and keep the frames it exchanges. The real
 * capture engine records these through Playwright; here the connection is made
 * with Node's built-in WebSocket, so the frames are genuine too.
 */
async function recordWebSocket(targetUrl: string, triggeredBy: string): Promise<CapturedWebSocket> {
  const openedAt = now();
  const frames: WebSocketFrame[] = [];

  await new Promise<void>((resolve) => {
    const socket = new WebSocket(targetUrl);
    socket.addEventListener('open', () => {
      const payload = JSON.stringify({
        type: 'subscribe',
        channel: 'prices',
        token: 'ws-secret-token',
      });
      frames.push(socketFrame('sent', payload));
      socket.send(payload);
    });
    let received = 0;
    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') frames.push(socketFrame('received', event.data));
      // The fixture greets and then acknowledges the subscribe; wait for both.
      received += 1;
      if (received >= 2) socket.close();
    });
    socket.addEventListener('close', () => resolve());
    socket.addEventListener('error', () => resolve());
    // Never let a silent server hang the example run.
    setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
    }, 2000);
  });

  const count = (direction: WebSocketFrame['direction']): number =>
    frames.filter((f) => f.direction === direction).length;

  return {
    url: normalizeUrl(targetUrl),
    origins: [new URL(targetUrl).origin],
    triggeredBy,
    openedAt,
    closedAt: now(),
    frameCount: frames.length,
    sentCount: count('sent'),
    receivedCount: count('received'),
    framesTruncated: false,
    frames,
    sentSchema: inferSchemaFromFrames(frames, 'sent'),
    receivedSchema: inferSchemaFromFrames(frames, 'received'),
  };
}

function socketFrame(direction: WebSocketFrame['direction'], payload: string): WebSocketFrame {
  return {
    direction,
    type: 'text',
    payloadSample: redactBody(payload),
    size: Buffer.byteLength(payload),
    truncated: false,
    at: now(),
  };
}

function titleOf(html: string): string | null {
  return /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? null;
}

function scriptSrcs(html: string): string[] {
  return [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => m[1]!);
}

/**
 * A stand-in for the previous scan, so the diff-aware dashboard example has all
 * three change kinds to show: an endpoint only the baseline had, one that is new
 * here, and one whose response schema narrowed. Fabricating the baseline keeps
 * the example to one crawl — the *current* half is still a real capture.
 */
function previousScan(report: ReconReport, baseUrl: string): ReconReport {
  const endpoints: Endpoint[] = report.endpoints
    .filter((e) => e.id !== PREVIOUS_NEW_ID)
    .map((e) => {
      if (e.id !== PREVIOUS_CHANGED_ID || !e.responseSchema?.properties) return e;
      const properties = { ...e.responseSchema.properties };
      delete properties['products'];
      return { ...e, responseSchema: { ...e.responseSchema, properties } };
    });

  endpoints.push({
    id: 'GET /api/legacy/orders',
    method: 'GET',
    urlPattern: '/api/legacy/orders',
    origins: [baseUrl],
    category: 'data-fetching',
    count: 12,
    statusCodes: [200],
    requestHeaders: { accept: 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBodySample: null,
    responseBodySample: '{"orders":[{"id":1042}]}',
    pathParams: [],
    queryParams: [],
    requestBodySchema: null,
    responseSchema: {
      type: 'object',
      properties: { orders: { type: 'array', items: { type: 'object' } } },
    },
    mimeTypes: ['application/json'],
    triggeredBy: [`${baseUrl}/dashboard`],
  });

  return {
    ...report,
    meta: {
      ...report.meta,
      startedAt: new Date(Date.parse(report.meta.startedAt) - 86_400_000).toISOString(),
    },
    endpoints,
  };
}

async function main(): Promise<void> {
  const fixture = await startFixtureServer({
    port: EXAMPLE_PORT,
    thirdPartyPort: EXAMPLE_THIRD_PARTY_PORT,
  });
  const evidence: TechEvidence[] = [];
  const pages = new Map<string, CapturedPage>();
  const calls: CapturedCall[] = [];
  const startedAt = now();

  const recordPage = async (path: string, depth: number, headers: Record<string, string> = {}): Promise<string> => {
    const url = `${fixture.url}${path}`;
    const res = await fetch(url, { headers, redirect: 'manual' });
    const html = await res.text();
    const normalized = normalizeUrl(url);
    pages.set(normalized, { url, normalizedUrl: normalized, depth, title: titleOf(html), visitedAt: now() });
    evidence.push({ url, headers: headersOf(res), html, cookies: [], scripts: scriptSrcs(html) });
    return html;
  };

  const recordCall = async (
    method: string,
    targetUrl: string,
    options: { body?: string; headers?: Record<string, string>; triggeredBy: string },
  ): Promise<Response> => {
    const t0 = now();
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
      durationMs: now() - t0,
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
    await recordPage('/graphql', 1);
    await recordPage('/websocket', 1);
    await recordPage('/external.html', 1);

    // --- login flow: real POST, real Set-Cookie ----------------------------
    const loginRes = await recordCall('POST', `${fixture.url}/api/login`, {
      body: JSON.stringify({ username: 'demo@example.com', password: 'hunter2' }),
      triggeredBy: `${fixture.url}/login`,
    });
    // A failed login, so the committed report shows an error contract beside the
    // success shape it belongs to.
    await recordCall('POST', `${fixture.url}/api/login`, {
      body: JSON.stringify({ username: 'demo@example.com', password: 'wrong' }),
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

    // --- GraphQL: an introspection query and a named operation ---------------
    await recordCall('POST', `${fixture.url}/api/graphql`, {
      body: JSON.stringify({
        operationName: 'IntrospectionQuery',
        query: 'query IntrospectionQuery { __schema { queryType { name } } }',
      }),
      triggeredBy: `${fixture.url}/graphql`,
    });
    await recordCall('POST', `${fixture.url}/api/graphql`, {
      body: JSON.stringify({
        operationName: 'GetProducts',
        query: 'query GetProducts($first: Int) { products { id name price } }',
        variables: { first: 3 },
      }),
      triggeredBy: `${fixture.url}/graphql`,
    });

    // --- third-party calls ---------------------------------------------------
    await recordCall('POST', `${fixture.thirdPartyUrl}/collect`, {
      body: JSON.stringify({ event: 'partner_impression' }),
      triggeredBy: `${fixture.url}/external.html`,
    });
    await recordCall('GET', `${fixture.thirdPartyUrl}/sdk/config.json`, {
      triggeredBy: `${fixture.url}/external.html`,
    });

    const webSockets = analyzeWebSockets([
      await recordWebSocket(`${fixture.url.replace(/^http/, 'ws')}/ws`, `${fixture.url}/websocket`),
    ]);

    const endpoints = analyzeCalls(calls, { seedUrl: fixture.url });
    const report: ReconReport = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      meta: {
        seedUrl: fixture.url,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now() - startedAt,
        pagesVisited: pages.size,
        apiReconVersion: TOOL_VERSION,
        // This sample is generated without a browser, so it records the engine
        // the real browser pipeline would use by default.
        engine: 'chromium',
      },
      technologies: detectTechnologies(evidence),
      endpoints,
      resources: groupResources(endpoints),
      pages: [...pages.values()],
      webSockets,
      safety: {
        robotsRespected: true,
        robotsSkippedPaths: [`${fixture.url}/admin`],
        rateLimitMs: 100,
        maxBodyBytes: 1024 * 1024,
        allowLocal: true,
        redact: true,
      },
    };

    report.findings = collectFindings(report);

    const files = await writeReports(report, FORMATS, OUT_DIR);
    console.log(`Wrote ${files.length} sample report(s):`);
    for (const file of files) console.log(`  • ${file}`);
    console.log('  (report.pdf is omitted — PDF rendering needs Chromium.)');

    // A second dashboard, this time with a baseline to compare against, so the
    // Change column and the highlighted removed endpoints are visible in the
    // committed examples. Written by hand because it shares the format's
    // filename with the plain dashboard above.
    const diff = diffReports(previousScan(report, fixture.url), report);
    for (const kind of ['added', 'removed', 'changed'] as const) {
      if (diff.counts[kind] === 0) {
        throw new Error(
          `The diff example no longer demonstrates a ${kind} change — update previousScan().`,
        );
      }
    }
    const diffFile = join(OUT_DIR, 'dashboard-diff.html');
    await writeFile(diffFile, renderDashboard({ ...report, diff }, 'API recon dashboard — with a baseline'), 'utf8');
    console.log(`  • ${diffFile}`);
    console.log(
      `  (diff example: ${diff.counts.added} added, ${diff.counts.removed} removed, ` +
        `${diff.counts.changed} changed, ${diff.counts.breaking} breaking)`,
    );
  } finally {
    await fixture.close();
  }
}

await main();
