/**
 * Drives the generated dashboard in a real browser.
 *
 * The dashboard renders client-side, so asserting on the HTML string only
 * proves the data ships — this suite proves the page actually works. It opens
 * the written file over `file://` so the standalone claim is exercised too.
 *
 * Requires `npx playwright install chromium`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, beforeEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { writeDashboardReport } from '../../src/reporters/dashboard.js';
import { browserAvailable } from '../helpers/browser.js';
import type { Endpoint, ReconReport, ReportDiff } from '../../src/types.js';

let browser: Browser | null = null;
let outDir: string;
let page: Page;
let pageErrors: string[] = [];
let canRunBrowser = false;

beforeEach((ctx) => {
  if (!canRunBrowser) ctx.skip();
});

function endpoint(overrides: Partial<Endpoint> & { id: string }): Endpoint {
  const [method, ...rest] = overrides.id.split(' ');
  return {
    method: method!,
    urlPattern: rest.join(' '),
    origins: ['https://example.com'],
    category: 'data-fetching',
    count: 1,
    statusCodes: [200],
    requestHeaders: { accept: 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBodySample: null,
    responseBodySample: '{"ok":true}',
    pathParams: [],
    queryParams: [{ name: 'page', sampleValues: ['2'] }],
    requestBodySchema: null,
    responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    mimeTypes: ['application/json'],
    triggeredBy: ['https://example.com/'],
    ...overrides,
  };
}

const DIFF: ReportDiff = {
  baseline: { seedUrl: 'https://example.com', startedAt: '2026-08-01T00:00:00.000Z', apiReconVersion: '0.1.1' },
  current: { seedUrl: 'https://example.com', startedAt: '2026-09-01T00:00:00.000Z', apiReconVersion: '0.1.2' },
  changes: [
    { id: 'GET /api/products', kind: 'changed', breaking: true, details: ['removed field products[].id'] },
    // Absent from this scan entirely, so it exists only as a diff change.
    { id: 'GET /api/legacy/orders', kind: 'removed', breaking: true, details: ['endpoint no longer observed'] },
  ],
  counts: { added: 0, removed: 1, changed: 1, breaking: 2 },
  hasChanges: true,
};

const REPORT: ReconReport = {
  schemaVersion: 1,
  meta: {
    seedUrl: 'https://example.com',
    startedAt: '2026-09-01T00:00:00.000Z',
    durationMs: 1234,
    pagesVisited: 2,
    apiReconVersion: '0.1.2',
    engine: 'chromium',
  },
  technologies: [{ name: 'Express', category: 'framework', evidence: 'x-powered-by: Express' }],
  endpoints: [
    endpoint({ id: 'GET /api/products', count: 3 }),
    endpoint({ id: 'POST /api/login', category: 'authentication', count: 1 }),
    endpoint({ id: 'POST /api/track', category: 'analytics', count: 2, statusCodes: [204] }),
  ],
  pages: [
    { url: 'https://example.com/', normalizedUrl: 'https://example.com/', depth: 0, title: 'Home', visitedAt: 0 },
    { url: 'https://example.com/dashboard', normalizedUrl: 'https://example.com/dashboard', depth: 1, title: 'Dash', visitedAt: 1 },
  ],
  webSockets: [],
  safety: {
    robotsRespected: true,
    robotsSkippedPaths: [],
    rateLimitMs: 500,
    maxBodyBytes: 1048576,
    allowLocal: false,
    redact: true,
  },
  diff: DIFF,
};

function rows(): Promise<string[]> {
  return page.$$eval('#rows tr.row', (els) => els.map((el) => el.textContent ?? ''));
}

async function shown(): Promise<string> {
  return (await page.textContent('#count')) ?? '';
}

beforeAll(async () => {
  canRunBrowser = await browserAvailable();
  if (!canRunBrowser) return;
  browser = await chromium.launch({ headless: true });
  outDir = await mkdtemp(join(tmpdir(), 'api-recon-dashboard-'));
});

afterAll(async () => {
  await browser?.close();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

describe('dashboard', () => {
  it('renders, searches, filters, sorts, and expands a report in a real browser', async () => {
    const file = await writeDashboardReport(REPORT, outDir);
    page = await browser!.newPage();
    pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(pathToFileURL(file).href);

    // --- initial render ----------------------------------------------------
    // Three endpoints from this scan, plus the one only the baseline saw.
    expect(await rows()).toHaveLength(4);
    expect(await shown()).toBe('4 of 4 shown (1 only in the baseline)');
    const stats = (await page.textContent('#stats')) ?? '';
    expect(stats).toContain('Endpoints');
    expect(stats).toContain('Technologies');
    expect(stats).toContain('Breaking');

    // --- free-text search --------------------------------------------------
    await page.fill('#q', 'login');
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toContain('/api/login');
    expect(await shown()).toBe('1 of 4 shown (1 only in the baseline)');

    await page.fill('#q', '');
    expect(await rows()).toHaveLength(4);

    // A removed endpoint is still searchable by its path.
    await page.fill('#q', 'legacy');
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toContain('/api/legacy/orders');
    await page.fill('#q', '');

    // The search index covers more than the visible columns.
    await page.fill('#q', 'analytics');
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toContain('/api/track');
    await page.fill('#q', '');

    // --- selects -----------------------------------------------------------
    await page.selectOption('#category', 'authentication');
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toContain('/api/login');
    await page.selectOption('#category', 'all');

    await page.selectOption('#status', '204');
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]).toContain('/api/track');
    await page.selectOption('#status', 'all');

    await page.selectOption('#method', 'POST');
    expect(await rows()).toHaveLength(2);
    await page.selectOption('#method', 'all');
    expect(await rows()).toHaveLength(4);

    // --- removed endpoints are first-class rows ----------------------------
    await page.selectOption('#category', '__removed');
    expect(await rows()).toHaveLength(1);
    expect(await page.locator('#rows tr.row.removed').count()).toBe(1);
    expect((await rows())[0]).toContain('/api/legacy/orders');
    expect((await rows())[0]).toContain('removed');
    // No samples exist for an endpoint that was not observed, so the expanded
    // row explains itself rather than showing empty sections.
    await page.click('#rows tr.row');
    const removedDetail = (await page.textContent('#rows tr.details')) ?? '';
    expect(removedDetail).toContain('baseline scan');
    expect(removedDetail).toContain('endpoint no longer observed');
    expect(removedDetail).not.toContain('Request headers');
    await page.click('#rows tr.row');
    await page.selectOption('#category', 'all');

    // --- diff filters ------------------------------------------------------
    await page.check('#breaking');
    expect(await rows()).toHaveLength(2);
    const breaking = (await rows()).join(' ');
    expect(breaking).toContain('/api/products');
    expect(breaking).toContain('/api/legacy/orders');
    await page.uncheck('#breaking');

    await page.check('#changed');
    expect(await rows()).toHaveLength(2);
    await page.uncheck('#changed');

    // --- sorting -----------------------------------------------------------
    await page.click('th[data-sort="count"]');
    // Ascending: the endpoint that was never called here sorts first.
    expect((await rows())[0]).toContain('/api/legacy/orders');
    await page.click('th[data-sort="count"]');
    expect((await rows())[0]).toContain('/api/products'); // descending: 3 calls

    // --- expanding a row ---------------------------------------------------
    await page.click('#rows tr.row');
    expect(await page.locator('#rows tr.details').count()).toBe(1);
    const details = (await page.textContent('#rows tr.details')) ?? '';
    expect(details).toContain('Response schema');
    expect(details).toContain('Query params');
    expect(details).toContain('page = 2');
    expect(details).toContain('Change since baseline');
    expect(details).toContain('removed field products[].id');
    expect(await page.getAttribute('#rows tr.row', 'aria-expanded')).toBe('true');

    // --- reset -------------------------------------------------------------
    await page.click('#reset');
    expect(await rows()).toHaveLength(4);
    expect(await shown()).toBe('4 of 4 shown (1 only in the baseline)');
    expect(await page.locator('#rows tr.details').count()).toBe(0);

    // A broken client script would surface here, not in a string assertion.
    expect(pageErrors).toEqual([]);
  }, 90_000);

  it('lists WebSocket connections and their frames', async () => {
    const withSockets: ReconReport = {
      ...REPORT,
      diff: undefined,
      webSockets: [
        {
          url: 'wss://example.com/live',
          origins: ['wss://example.com'],
          triggeredBy: 'https://example.com/',
          openedAt: 0,
          closedAt: 10,
          frameCount: 2,
          sentCount: 1,
          receivedCount: 1,
          framesTruncated: false,
          frames: [
            { direction: 'sent', type: 'text', payloadSample: '{"subscribe":true}', size: 17, truncated: false, at: 1 },
            { direction: 'received', type: 'text', payloadSample: '{"ok":true}', size: 11, truncated: false, at: 2 },
          ],
          sentSchema: { type: 'object', properties: { subscribe: { type: 'boolean' } } },
          receivedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        },
      ],
    };
    const file = await writeDashboardReport(withSockets, join(outDir, 'sockets'));
    page = await browser!.newPage();
    pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(pathToFileURL(file).href);

    // Three endpoints plus the WebSocket connection, which has no baseline here.
    expect(await rows()).toHaveLength(4);
    const socketRow = (await rows()).find((row) => row.includes('/live'));
    expect(socketRow, 'the socket should have a row').toBeDefined();
    expect(socketRow).toContain('WS');
    expect(socketRow).toContain('websocket');
    expect((await page.textContent('#stats')) ?? '').toContain('WebSockets');

    await page.selectOption('#category', 'websocket');
    expect(await rows()).toHaveLength(1);
    await page.click('#rows tr.row');
    const details = (await page.textContent('#rows tr.details')) ?? '';
    expect(details).toContain('Frames');
    expect(details).toContain('sent · text');
    expect(details).toContain('{"subscribe":true}');
    expect(details).toContain('Sent schema');
    expect(details).toContain('Received schema');
    expect(details).not.toContain('Request headers');
    expect(pageErrors).toEqual([]);
  }, 90_000);

  it('colours finding tiles and supports keyboard navigation', async () => {
    const withFindings: ReconReport = {
      ...REPORT,
      diff: undefined,
      findings: [
        {
          kind: 'unauthenticated',
          severity: 'high',
          title: 'Sensitive-looking endpoints answered without credentials',
          endpoints: ['GET /api/products'],
          details: ['GET /api/products — no Authorization or Cookie header; observed 200'],
        },
        {
          kind: 'pii',
          severity: 'medium',
          title: 'PII-shaped fields appear in captured samples',
          endpoints: ['GET /api/products'],
          details: ['GET /api/products — email'],
        },
      ],
    };
    const file = await writeDashboardReport(withFindings, join(outDir, 'findings'));
    page = await browser!.newPage();
    pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(pathToFileURL(file).href);

    // --- severity-coloured tiles -------------------------------------------
    const stats = (await page.textContent('#stats')) ?? '';
    expect(stats).toContain('High');
    expect(stats).toContain('Medium');
    expect(await page.locator('.tile.bad').count()).toBe(1);
    expect(await page.locator('.tile.warn').count()).toBe(1);

    // --- findings panel ----------------------------------------------------
    const findings = (await page.textContent('#findings')) ?? '';
    expect(findings).toContain('Sensitive-looking endpoints');

    // --- keyboard: slash focuses search ------------------------------------
    await page.locator('h1').click();
    await page.keyboard.press('/');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id)).toBe('q');

    // --- keyboard: arrow keys walk the rows ---------------------------------
    await page.locator('#rows tr.row').first().focus();
    const first = await page.evaluate(() => document.activeElement?.getAttribute('data-id'));
    await page.keyboard.press('ArrowDown');
    const next = await page.evaluate(() => document.activeElement?.getAttribute('data-id'));
    expect(next).not.toBe(first);
    expect(next).not.toBeNull();

    expect(pageErrors).toEqual([]);
  }, 90_000);

  it('hides the diff-only filters when there is no baseline', async () => {
    const file = await writeDashboardReport({ ...REPORT, diff: undefined }, join(outDir, 'nodiff'));
    page = await browser!.newPage();
    pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(pathToFileURL(file).href);

    expect(await rows()).toHaveLength(3);
    expect(await page.locator('th[data-sort="change"]').count()).toBe(0);
    expect(await page.isHidden('#breaking')).toBe(true);
    expect(await page.isHidden('#changed')).toBe(true);
    expect(pageErrors).toEqual([]);
  }, 90_000);
});
