import { describe, expect, it } from 'vitest';
import {
  buildPdfDocument,
  pdfFooterTemplate,
  pdfHeaderTemplate,
  seedHost,
  type PdfCoverInfo,
} from '../../src/reporters/pdf.js';

const info: PdfCoverInfo = {
  seedUrl: 'http://127.0.0.1:4610',
  startedAt: '2026-01-01T00:00:00.000Z',
  toolVersion: '0.3.7',
  schemaVersion: 1,
  summary: 'Scorecard — 10 endpoints · 8 pages in 280ms',
};

const page = `<!doctype html>
<html lang="en"><head><title>API recon — http://127.0.0.1:4610</title>
<style>.x { color: red; }</style></head>
<body>
<main>
<h1>API recon report</h1>
<p><em>_Scorecard — 10 endpoints._</em></p>
<h2>Contents</h2>
<h2>1. Overview</h2>
<section class="detail"><h3>GET /api/products</h3><table><tr><td>200</td></tr></table></section>
</main>
</body>
</html>`;

describe('pdf cover page', () => {
  it('leads with a cover naming the seed host, tool, and schema version', () => {
    const doc = buildPdfDocument(page, info);

    expect(doc).toContain('<section class="pdf-cover">');
    expect(doc).toContain('127.0.0.1:4610');
    expect(doc).toContain('api-recon v0.3.7');
    expect(doc).toContain('<dd>v1</dd>');
    expect(doc).toContain('2026-01-01T00:00:00.000Z');
    expect(doc).toContain(info.summary);
    // The cover comes before the report itself, and breaks to its own page.
    expect(doc.indexOf('pdf-cover')).toBeLessThan(doc.indexOf('<h2>1. Overview</h2>'));
    expect(doc).toContain('break-after: page;');
  });

  it('drops the report h1 so the title is not printed twice', () => {
    const doc = buildPdfDocument(page, info);
    expect(doc).not.toContain('<h1>API recon report</h1>');
    expect(doc).toContain('<h1 class="pdf-title">API recon report</h1>');
  });

  it('keeps the shared stylesheet and the detail sections intact', () => {
    const doc = buildPdfDocument(page, info);
    expect(doc).toContain('<style>.x { color: red; }</style>');
    expect(doc).toContain('<section class="detail"><h3>GET /api/products</h3>');
    expect(doc).toContain('</head>');
  });

  it('escapes anything a seed URL could smuggle into the cover', () => {
    const doc = buildPdfDocument(page, { ...info, seedUrl: 'http://x/<img src=x>' });
    expect(doc).not.toContain('<img src=x>');
    expect(doc).toContain('&lt;img src=x&gt;');
  });
});

describe('pdf running header and footer', () => {
  it('prints the seed host and the report identity', () => {
    expect(pdfHeaderTemplate(info)).toContain('127.0.0.1:4610');
    expect(pdfHeaderTemplate(info)).toContain('API recon report');
    expect(pdfFooterTemplate(info)).toContain('127.0.0.1:4610 · api-recon v0.3.7');
  });

  it('numbers pages with the placeholders Chromium fills in', () => {
    const footer = pdfFooterTemplate(info);
    expect(footer).toContain('<span class="pageNumber"></span>');
    expect(footer).toContain('<span class="totalPages"></span>');
  });

  it('escapes the host it is handed', () => {
    const weird = { ...info, seedUrl: 'http://a/<b>' };
    expect(pdfHeaderTemplate(weird)).not.toContain('</b>');
    expect(pdfFooterTemplate(weird)).not.toContain('</b>');
  });
});

describe('seedHost', () => {
  it('reduces a seed URL to its host', () => {
    expect(seedHost('https://example.com:8443/app?q=1')).toBe('example.com:8443');
  });

  it('falls back to the raw value when it is not a URL', () => {
    expect(seedHost('not a url')).toBe('not a url');
  });
});
