import { describe, expect, it } from 'vitest';
import { BRAND_NAME, brandMark, faviconHref, faviconLink } from '../../src/reporters/brand.js';
import { THEME_TOKENS } from '../../src/reporters/theme.js';
import { renderHtml } from '../../src/reporters/html.js';
import { renderDashboard } from '../../src/reporters/dashboard.js';
import type { ReconReport } from '../../src/types.js';

describe('brandMark', () => {
  it('is an inline SVG named for the product', () => {
    const mark = brandMark();
    expect(mark.startsWith('<svg class="brand-mark"')).toBe(true);
    expect(mark).toContain('viewBox="0 0 24 24"');
    expect(mark).toContain('role="img"');
    expect(mark).toContain(`aria-label="${BRAND_NAME}"`);
    expect(mark).toContain('</svg>');
  });

  it('takes its colours from the ramp, so it follows dark mode and print', () => {
    const mark = brandMark();
    expect(mark).toContain('fill="var(--brand-500)"');
    expect(mark).toContain('stroke="var(--brand-50)"');
    expect(mark).not.toMatch(/#[0-9a-f]{6}/i);
  });

  it('honours the requested size', () => {
    expect(brandMark(18)).toContain('width="18" height="18"');
    expect(brandMark()).toContain('width="22" height="22"');
  });
});

describe('favicon', () => {
  it('is a self-contained data URI holding an SVG document', () => {
    const href = faviconHref();
    expect(href.startsWith('data:image/svg+xml,')).toBe(true);

    const svg = decodeURIComponent(href.slice('data:image/svg+xml,'.length));
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('</svg>');
  });

  it('inlines the ramp rather than referencing tokens a favicon cannot see', () => {
    const svg = decodeURIComponent(faviconHref().slice('data:image/svg+xml,'.length));
    expect(svg).toContain('#4f6ef7');
    expect(svg).not.toContain('var(--');
  });

  it('links with the SVG type so browsers pick it up', () => {
    expect(faviconLink()).toContain('<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,');
  });
});

describe('the colour ramp', () => {
  it('documented the steps it uses', () => {
    expect(THEME_TOKENS).toContain('-50   tinted surface');
    expect(THEME_TOKENS).toContain('-700  readable ink');
  });

  it('states each hue once per mode and points the roles at it', () => {
    for (const token of ['--brand-500', '--brand-200', '--green-700', '--amber-50', '--red-700', '--blue-50']) {
      expect(THEME_TOKENS, `${token} should be declared`).toContain(`${token}:`);
    }
    // The status and accent roles are aliases, so dark mode only has to move the ramp.
    expect(THEME_TOKENS).toContain('--ok: var(--green-700)');
    expect(THEME_TOKENS).toContain('--accent: var(--brand-500)');
    expect(THEME_TOKENS).toContain('--accent-soft: var(--brand-200)');
  });

  it('pins the light ramp for print, whatever scheme the machine is in', () => {
    // Once in `:root`, once again inside the print block: a report printed from a
    // dark desktop must not put dark ink on the black print tile.
    expect(THEME_TOKENS.match(/--brand-50: #eef2ff/g)).toHaveLength(2);
    const print = THEME_TOKENS.slice(THEME_TOKENS.indexOf('@media print'));
    expect(print).toContain('--brand-50: #eef2ff');
    expect(print).toContain('--brand-200: #bbbbbb');
  });
});

describe('the identity in the artifacts', () => {
  const recon = (): ReconReport => ({
    schemaVersion: 1,
    meta: {
      seedUrl: 'https://example.com',
      startedAt: '2026-09-01T00:00:00.000Z',
      durationMs: 1000,
      pagesVisited: 1,
      apiReconVersion: '0.2.2',
      engine: 'chromium',
    },
    technologies: [],
    endpoints: [],
    pages: [],
    webSockets: [],
    safety: {
      robotsRespected: true,
      robotsSkippedPaths: [],
      rateLimitMs: 0,
      maxBodyBytes: 1024,
      allowLocal: true,
      redact: true,
    },
  });

  it('puts the mark in the report masthead and the favicon in the head', async () => {
    const html = await renderHtml('# API recon report\n', 'Report');
    expect(html).toMatch(/<h1[^>]*><svg class="brand-mark"/);
    expect(html).toContain('<link rel="icon" type="image/svg+xml"');
    expect(html).toContain('.brand-mark { vertical-align');
  });

  it('puts the same identity in the dashboard', () => {
    const html = renderDashboard(recon());
    expect(html).toContain('<h1><svg class="brand-mark"');
    expect(html).toContain('API recon dashboard');
    expect(html).toContain('<link rel="icon" type="image/svg+xml"');
  });
});
