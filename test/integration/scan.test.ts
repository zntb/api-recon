/**
 * End-to-end tests: a real headless Chromium is driven against the local
 * fixture server. Requires `npx playwright install chromium`.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { load } from 'js-yaml';
import { startFixtureServer, type FixtureServerHandle } from '../fixtures/server.js';
import { browserAvailable } from '../helpers/browser.js';
import { scan, Logger } from '../../src/index.js';
import type { Endpoint, ReconReport } from '../../src/index.js';

let fixture: FixtureServerHandle;
let outDir: string;
let canRunBrowser = false;

beforeEach((ctx) => {
  if (!canRunBrowser) ctx.skip();
});

const silent = (): Logger => new Logger({ quiet: true });

const FIXTURE_USER = 'demo@example.com';
const FIXTURE_PASS = 'hunter2';
const SESSION_FILE = 'test/output/session.json';

beforeAll(async () => {
  canRunBrowser = await browserAvailable();
  fixture = await startFixtureServer({ port: 0, thirdPartyPort: 0 });
  outDir = await mkdtemp(join(tmpdir(), 'api-recon-out-'));
  process.env.FIXTURE_BASE_URL = fixture.url;
  process.env.FIXTURE_USER = FIXTURE_USER;
  process.env.FIXTURE_PASS = FIXTURE_PASS;
});

afterAll(async () => {
  await fixture.close();
  await rm(outDir, { recursive: true, force: true });
  delete process.env.FIXTURE_BASE_URL;
});

async function readJsonReport(dir: string): Promise<ReconReport> {
  return JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as ReconReport;
}

function findEndpoint(report: ReconReport, id: string): Endpoint | undefined {
  return report.endpoints.find((e) => e.id === id);
}

describe('capture and categorization', () => {
  it('captures same-origin API calls, categorizes them, and respects robots.txt', async () => {
    const dir = join(outDir, 'basic');
    const result = await scan({
      url: fixture.url,
      depth: 1,
      allowLocal: true,
      rate: 0,
      formats: ['json'],
      out: dir,
      logger: silent(),
    });

    const report = result.report;
    expect(report.meta.pagesVisited).toBeGreaterThan(1);
    expect(report.meta.engine).toBe('chromium');

    const products = findEndpoint(report, 'GET /api/products');
    expect(products, 'GET /api/products should be captured').toBeDefined();
    expect(products!.category).toBe('data-fetching');
    expect(products!.statusCodes).toContain(200);
    expect(products!.responseSchema?.properties).toHaveProperty('products');

    const beacon = findEndpoint(report, 'POST /api/collect');
    expect(beacon, 'POST /api/collect should be captured').toBeDefined();
    expect(beacon!.category).toBe('analytics');

    const graphql = findEndpoint(report, 'POST /api/graphql');
    expect(graphql, 'POST /api/graphql should be captured').toBeDefined();
    expect(graphql!.category).toBe('graphql');
    expect(graphql!.graphql?.introspection).toBe(true);
    const operationNames = graphql!.graphql!.operations.map((op) => op.name);
    expect(operationNames).toContain('IntrospectionQuery');
    expect(operationNames).toContain('GetProducts');

    const socket = report.webSockets.find((ws) => ws.url.includes('/ws'));
    expect(socket, 'the fixture page opens a WebSocket').toBeDefined();
    expect(socket!.sentCount).toBeGreaterThanOrEqual(1);
    expect(socket!.receivedCount).toBeGreaterThanOrEqual(1);
    expect(socket!.frameCount).toBeGreaterThanOrEqual(2);
    expect(socket!.triggeredBy).toContain('/websocket');
    // Frame payloads are redacted exactly like request bodies.
    const framePayloads = socket!.frames.map((f) => f.payloadSample ?? '').join(' ');
    expect(framePayloads).toContain('[REDACTED]');
    expect(framePayloads).not.toContain('ws-secret-token');
    // JSON frames are summarized into message schemas, like request/response bodies.
    expect(socket!.sentSchema?.properties).toHaveProperty('type');
    expect(socket!.receivedSchema?.properties).toHaveProperty('type');

    expect(findEndpoint(report, 'POST /api/login')).toBeUndefined();

    for (const endpoint of report.endpoints) {
      expect(endpoint.origins.some((o) => o === fixture.thirdPartyUrl)).toBe(false);
    }

    expect(report.safety.robotsRespected).toBe(true);
    expect(report.safety.robotsSkippedPaths.some((p) => p.endsWith('/admin'))).toBe(true);
    expect(report.pages.some((p) => p.normalizedUrl.includes('/admin'))).toBe(false);
    expect(report.endpoints.some((e) => e.urlPattern.includes('admin'))).toBe(false);

    expect(report.technologies.map((t) => t.name)).toContain('Express');

    const written = await readJsonReport(dir);
    expect(written.endpoints.length).toBe(report.endpoints.length);
    expect(written.webSockets.length).toBe(report.webSockets.length);
    expect(result.files.some((f) => f.endsWith('report.json'))).toBe(true);
  }, 120_000);

  it('includes cross-origin calls only when third-party capture is enabled', async () => {
    const result = await scan({
      url: fixture.url,
      depth: 1,
      allowLocal: true,
      rate: 0,
      includeThirdParty: true,
      formats: ['json'],
      out: join(outDir, 'third-party'),
      logger: silent(),
    });

    const partnerConfig = result.report.endpoints.find(
      (e) => e.urlPattern === '/sdk/config.json' && e.origins.includes(fixture.thirdPartyUrl),
    );
    expect(partnerConfig, 'third-party calls should be captured when enabled').toBeDefined();
    expect(partnerConfig!.category).toBe('third-party');

    const crossOriginCollect = result.report.endpoints.find(
      (e) => e.urlPattern === '/collect' && e.origins.includes(fixture.thirdPartyUrl),
    );
    expect(crossOriginCollect).toBeDefined();
    expect(crossOriginCollect!.category).toBe('analytics');
  }, 120_000);

  it('refuses a robots-disallowed seed URL unless forced', async () => {
    await expect(
      scan({
        url: `${fixture.url}/admin`,
        allowLocal: true,
        rate: 0,
        formats: ['json'],
        out: join(outDir, 'blocked'),
        logger: silent(),
      }),
    ).rejects.toThrow(/robots\.txt disallows/);

    const forced = await scan({
      url: `${fixture.url}/admin`,
      allowLocal: true,
      rate: 0,
      force: true,
      formats: ['json'],
      logger: silent(),
    });
    expect(forced.report.safety.robotsRespected).toBe(false);
    expect(forced.report.pages.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('authentication', () => {
  it('logs in with a scripted flow, captures protected APIs, and redacts secrets', async () => {
    const dir = join(outDir, 'auth');
    const result = await scan({
      url: fixture.url,
      depth: 1,
      allowLocal: true,
      rate: 0,
      login: 'test/fixtures/login.yaml',
      formats: ['json'],
      out: dir,
      logger: silent(),
    });

    const report = result.report;
    const login = findEndpoint(report, 'POST /api/login');
    expect(login, 'POST /api/login should be captured').toBeDefined();
    expect(login!.category).toBe('authentication');
    expect(login!.statusCodes).toContain(200);

    const user = findEndpoint(report, 'GET /api/user');
    const orders = findEndpoint(report, 'GET /api/orders');
    expect(user, 'GET /api/user needs authentication').toBeDefined();
    expect(orders, 'GET /api/orders needs authentication').toBeDefined();
    expect(user!.statusCodes).toContain(200);
    expect(orders!.statusCodes).toContain(200);

    // Credentials never reach the report.
    const raw = await readFile(join(dir, 'report.json'), 'utf8');
    expect(raw).not.toContain(FIXTURE_PASS);
    expect(raw).not.toContain('connect.sid=');
    expect(raw).toContain('[REDACTED]');
  }, 120_000);

  it('reuses a saved session with --auth', async () => {
    const result = await scan({
      url: `${fixture.url}/dashboard`,
      depth: 0,
      allowLocal: true,
      rate: 0,
      auth: SESSION_FILE,
      formats: ['json'],
      logger: silent(),
    });

    const user = findEndpoint(result.report, 'GET /api/user');
    const orders = findEndpoint(result.report, 'GET /api/orders');
    expect(user?.statusCodes).toContain(200);
    expect(orders?.statusCodes).toContain(200);
  }, 120_000);
});

describe('scripted actions', () => {
  it('clicks "load more" and submits the search form', async () => {
    const result = await scan({
      url: `${fixture.url}/products`,
      depth: 0,
      allowLocal: true,
      rate: 0,
      actions: 'test/fixtures/actions.json',
      formats: ['json'],
      logger: silent(),
    });

    const products = findEndpoint(result.report, 'GET /api/products');
    expect(products).toBeDefined();
    expect(products!.queryParams.map((q) => q.name)).toContain('page');
    const pageParam = products!.queryParams.find((q) => q.name === 'page');
    expect(pageParam!.sampleValues).toContain('2');

    const search = findEndpoint(result.report, 'POST /api/search');
    expect(search, 'POST /api/search should be captured after submitting the form').toBeDefined();
    expect(search!.category).toBe('mutations');
    expect(search!.requestBodySample).toContain('widget');
  }, 120_000);
});

describe('opt-in telemetry', () => {
  it('is off by default and, when enabled, writes anonymized signals only', async () => {
    const off = await scan({
      url: fixture.url,
      depth: 1,
      allowLocal: true,
      rate: 0,
      formats: ['json'],
      logger: silent(),
    });
    expect(off.telemetry).toBeUndefined();
    expect(off.files.some((f) => f.endsWith('telemetry.json'))).toBe(false);

    const dir = join(outDir, 'telemetry');
    const on = await scan({
      url: fixture.url,
      depth: 1,
      allowLocal: true,
      rate: 0,
      formats: ['json'],
      out: dir,
      telemetry: true,
      logger: silent(),
    });

    expect(on.telemetry?.endpointCount).toBeGreaterThan(0);
    expect(on.files.some((f) => f.endsWith('telemetry.json'))).toBe(true);

    const raw = await readFile(join(dir, 'telemetry.json'), 'utf8');
    const host = new URL(fixture.url).host;
    expect(raw).not.toContain(host);
    expect(raw).not.toContain('/api/products');
    expect(raw).not.toContain('ws-secret-token');
    expect(raw).toContain('No host, path, query values, headers, or bodies');

    const parsed = JSON.parse(raw) as { endpointCount: number; signals: unknown[] };
    expect(parsed.signals).toHaveLength(parsed.endpointCount);
  }, 120_000);
});

describe('report formats', () => {
  it('writes json, md, html, pdf, openapi, and the dashboard with redaction intact', async () => {
    const dir = join(outDir, 'formats');
    const result = await scan({
      url: fixture.url,
      depth: 1,
      allowLocal: true,
      rate: 0,
      includeThirdParty: true,
      // The login flow is what puts secrets in the capture (Set-Cookie plus a
      // password in a request body), so redaction is actually exercised.
      login: 'test/fixtures/login.yaml',
      formats: ['json', 'md', 'html', 'pdf', 'openapi', 'dashboard'],
      out: dir,
      logger: silent(),
    });

    const names = result.files.map((f) => basename(f));
    expect(names).toEqual(
      expect.arrayContaining([
        'report.json',
        'report.md',
        'report.html',
        'report.pdf',
        'openapi.yaml',
        'dashboard.html',
      ]),
    );

    const md = await readFile(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('## 1. Overview');
    expect(md).toContain('| Browser engine | chromium |');
    expect(md).toContain('## 3. Endpoint Summary by Category');
    expect(md).toContain('## 7. Safety Notes');
    expect(md).toContain('## 8. WebSocket Traffic');
    expect(md).toContain('[REDACTED]');
    expect(md).not.toContain(FIXTURE_PASS);
    expect(md).not.toContain('connect.sid=');
    expect(md).not.toContain('ws-secret-token');

    const html = await readFile(join(dir, 'report.html'), 'utf8');
    expect(html).toContain('<style>');
    expect(html).toContain('Endpoint Summary by Category');
    expect(html).not.toContain(FIXTURE_PASS);

    const json = await readFile(join(dir, 'report.json'), 'utf8');
    expect(json).toContain('[REDACTED]');
    expect(json).not.toContain(FIXTURE_PASS);
    expect(json).not.toContain('connect.sid=');

    const pdf = await readFile(join(dir, 'report.pdf'));
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(1000);

    const spec = load(await readFile(join(dir, 'openapi.yaml'), 'utf8')) as {
      openapi: string;
      paths: Record<string, Record<string, unknown>>;
    };
    expect(spec.openapi).toBe('3.0.3');
    expect(Object.keys(spec.paths)).toContain('/api/products');
    expect(spec.paths['/api/products']!['get']).toBeDefined();

    // The dashboard embeds the report verbatim, so the same redaction promise
    // has to hold for it — including for the JSON payload, not just the markup.
    const dashboard = await readFile(join(dir, 'dashboard.html'), 'utf8');
    expect(dashboard).toContain('API recon dashboard');
    expect(dashboard).not.toContain(FIXTURE_PASS);
    expect(dashboard).not.toContain('connect.sid=');
    const payload = JSON.parse(
      /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(dashboard)![1]!,
    ) as ReconReport;
    expect(payload.endpoints.map((e) => e.id)).toEqual(result.report.endpoints.map((e) => e.id));
    expect(payload.endpoints.some((e) => e.id === 'GET /api/products')).toBe(true);
  }, 180_000);
});

describe('record mode', () => {
  it('captures traffic until the session is stopped', async () => {
    process.env.API_RECON_HEADLESS = '1';
    process.env.API_RECON_RECORD_AUTOSTOP_MS = '1200';
    try {
      const dir = join(outDir, 'record');
      const result = await scan({
        url: `${fixture.url}/products`,
        record: true,
        allowLocal: true,
        rate: 0,
        formats: ['json'],
        out: dir,
        logger: silent(),
      });
      expect(result.report.endpoints.some((e) => e.id === 'GET /api/products')).toBe(true);
      expect(result.report.pages.length).toBeGreaterThan(0);
    } finally {
      delete process.env.API_RECON_HEADLESS;
      delete process.env.API_RECON_RECORD_AUTOSTOP_MS;
    }
  }, 120_000);
});
