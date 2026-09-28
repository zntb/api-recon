/**
 * Multi-engine integration tests: a real Firefox and WebKit are driven against
 * the fixture site.
 *
 * Each case skips itself when its engine is not installed, so a Chromium-only
 * checkout still runs the rest of the suite — but CI installs all three, which
 * is what actually proves the engines work.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixtureServer, type FixtureServerHandle } from '../fixtures/server.js';
import { browserAvailable } from '../helpers/browser.js';
import { BROWSER_ENGINES, Logger, scan } from '../../src/index.js';
import type { BrowserEngine } from '../../src/index.js';

let fixture: FixtureServerHandle;

const silent = (): Logger => new Logger({ quiet: true });

/** Chromium is covered thoroughly by scan.test.ts, so only vary the others. */
const NON_DEFAULT_ENGINES = BROWSER_ENGINES.filter((engine) => engine !== 'chromium');

beforeAll(async () => {
  fixture = await startFixtureServer({ port: 0, thirdPartyPort: 0 });
});

afterAll(async () => {
  await fixture.close();
});

describe('browser engines', () => {
  for (const engine of NON_DEFAULT_ENGINES) {
    it(`captures the fixture site's API surface in ${engine}`, async (ctx) => {
      if (!(await browserAvailable(engine))) ctx.skip();

      const result = await scan({
        url: fixture.url,
        depth: 1,
        allowLocal: true,
        rate: 0,
        formats: ['json'],
        browser: engine,
        logger: silent(),
      });

      // Same assertions as the Chromium suite's happy path: interception,
      // categorization, and technology detection must be engine-independent.
      const products = result.report.endpoints.find((e) => e.id === 'GET /api/products');
      expect(products, `GET /api/products should be captured in ${engine}`).toBeDefined();
      expect(products!.category).toBe('data-fetching');
      expect(products!.statusCodes).toContain(200);
      expect(products!.responseSchema?.properties).toHaveProperty('products');

      expect(result.report.meta.pagesVisited).toBeGreaterThan(1);
      expect(result.report.technologies.map((t) => t.name)).toContain('Express');
    }, 180_000);
  }

  it('still respects robots.txt and the local guard on a non-default engine', async (ctx) => {
    const engine: BrowserEngine = NON_DEFAULT_ENGINES[0]!;
    if (!(await browserAvailable(engine))) ctx.skip();

    await expect(
      scan({
        url: `${fixture.url}/admin`,
        allowLocal: true,
        rate: 0,
        formats: ['json'],
        browser: engine,
        logger: silent(),
      }),
    ).rejects.toThrow(/robots\.txt disallows/);

    await expect(
      scan({ url: 'http://127.0.0.1:9/', browser: engine, formats: [] }),
    ).rejects.toThrow(/allow-local/);
  }, 120_000);
});
