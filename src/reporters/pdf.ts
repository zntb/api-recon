/**
 * PDF reporter. Uses Playwright's Chromium `page.pdf()` (no extra engine) with
 * a fresh headless browser so it never depends on the scan session's state.
 * Failure is non-fatal: callers log a warning and keep the other formats.
 *
 * The PDF is the HTML report plus the page furniture HTML cannot express: a
 * cover, running headers and footers with page numbers, and break rules that
 * keep one endpoint's detail on one page. `buildPdfDocument` and the two
 * template builders are pure so the layout can be tested without a browser.
 */

import { chromium } from 'playwright';
import { SESSION_LAUNCH_OPTIONS } from '../core/browser.js';
import { escapeHtml } from './html.js';
import { brandMark } from './brand.js';

/** What the cover and the running headers need to identify this document. */
export interface PdfCoverInfo {
  seedUrl: string;
  startedAt: string;
  toolVersion: string;
  schemaVersion: number;
  /** The plain-text scorecard line, shared with the Markdown report. */
  summary: string;
}

const PDF_STYLE = `
  .pdf-cover { padding-top: 30mm; break-after: page; }
  .pdf-cover .pdf-kicker { margin: 0; font-size: .8rem; font-weight: 600;
    letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
  .pdf-cover .pdf-kicker .brand-mark { vertical-align: -0.25em; margin-right: .45em; }
  .pdf-cover .pdf-title { margin: .4rem 0 0; font-size: 2.4rem; letter-spacing: -0.02em; }
  .pdf-cover .pdf-host { margin: .3rem 0 2rem; font-size: 1.15rem; color: var(--link); }
  .pdf-cover .pdf-summary { margin: 0 0 2rem; color: var(--muted); }
  .pdf-cover .pdf-facts { display: grid; grid-template-columns: 9rem 1fr; gap: .35rem 1rem;
    margin: 0 0 2rem; font-size: .85rem; }
  .pdf-cover .pdf-facts dt { color: var(--muted); }
  .pdf-cover .pdf-facts dd { margin: 0; font-family: var(--font-mono); word-break: break-word; }
  .pdf-cover .pdf-note { margin: 0; padding-top: 1rem; border-top: 1px solid var(--line);
    font-size: .8rem; color: var(--muted); }
  @media print {
    main { padding: 0; }
  }
`;

/** The host a reader recognizes the capture by, falling back to the raw seed. */
export function seedHost(seedUrl: string): string {
  try {
    return new URL(seedUrl).host;
  } catch {
    return seedUrl;
  }
}

function coverMarkup(info: PdfCoverInfo): string {
  const facts: [string, string][] = [
    ['Seed URL', info.seedUrl],
    ['Captured', info.startedAt],
    ['Tool', `api-recon v${info.toolVersion}`],
    ['Report schema', `v${info.schemaVersion}`],
  ];
  const rows = facts
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');
  return `<section class="pdf-cover">
  <p class="pdf-kicker">${brandMark(18)}api-recon</p>
  <h1 class="pdf-title">API recon report</h1>
  <p class="pdf-host">${escapeHtml(seedHost(info.seedUrl))}</p>
  <p class="pdf-summary">${escapeHtml(info.summary)}</p>
  <dl class="pdf-facts">${rows}</dl>
  <p class="pdf-note">Figures come from the traffic one scan triggered. A scan samples whatever
  the pages actually did, so an endpoint that is missing may simply not have been exercised.</p>
</section>`;
}

/**
 * The printable document: shared style plus the PDF-only rules, a cover page,
 * and the body with its own `<h1>` dropped (the cover carries the title, so the
 * report itself starts at the scorecard and the contents).
 */
export function buildPdfDocument(html: string, info: PdfCoverInfo): string {
  const styled = html.replace('</head>', `<style>${PDF_STYLE}</style>\n</head>`);
  const [before, ...rest] = styled.split('<main>');
  const body = rest.join('<main>').replace(/<h1[^>]*>[\s\S]*?<\/h1>\s*/, '');
  return `${before}<main>\n${coverMarkup(info)}\n${body}`;
}

/** Running header: what the document is on the left, where it came from right. */
export function pdfHeaderTemplate(info: PdfCoverInfo): string {
  return `<div style="width:100%;padding:0 12mm 2mm;font-family:Arial,Helvetica,sans-serif;font-size:8px;color:#5b6675;display:flex;justify-content:space-between;border-bottom:1px solid #e3e7ee;">
    <span>API recon report</span><span>${escapeHtml(seedHost(info.seedUrl))}</span></div>`;
}

/** Running footer: the seed host and tool on the left, "Page N of M" on the right. */
export function pdfFooterTemplate(info: PdfCoverInfo): string {
  return `<div style="width:100%;padding:2mm 12mm 0;font-family:Arial,Helvetica,sans-serif;font-size:8px;color:#5b6675;display:flex;justify-content:space-between;border-top:1px solid #e3e7ee;">
    <span>${escapeHtml(seedHost(info.seedUrl))} · api-recon v${escapeHtml(info.toolVersion)}</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
}

export async function writePdfReport(
  html: string,
  outFile: string,
  info: PdfCoverInfo,
): Promise<boolean> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    // The same reason as the scan's own session: Playwright's default SIGINT
    // handling hard-exits with 130, which would truncate the set of formats
    // half-written. This render finishes and the CLI reports the signal.
    browser = await chromium.launch({ headless: true, ...SESSION_LAUNCH_OPTIONS });
    const page = await browser.newPage();
    await page.setContent(buildPdfDocument(html, info), { waitUntil: 'load' });
    await page.pdf({
      path: outFile,
      format: 'A4',
      printBackground: true,
      // Both templates must be supplied together, or Chromium prints its own
      // title/URL/date furniture instead of ours.
      displayHeaderFooter: true,
      headerTemplate: pdfHeaderTemplate(info),
      footerTemplate: pdfFooterTemplate(info),
      // The margins have to clear the header and footer bands.
      margin: { top: '22mm', bottom: '18mm', left: '12mm', right: '12mm' },
    });
    return true;
  } catch {
    return false;
  } finally {
    await browser?.close().catch(() => {});
  }
}
