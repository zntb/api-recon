/**
 * PDF reporter. Uses Playwright's Chromium `page.pdf()` (no extra engine) with
 * a fresh headless browser so it never depends on the scan session's state.
 * Failure is non-fatal: callers log a warning and keep the other formats.
 */

import { chromium } from 'playwright';

export async function writePdfReport(html: string, outFile: string): Promise<boolean> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: outFile,
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    });
    return true;
  } catch {
    return false;
  } finally {
    await browser?.close().catch(() => {});
  }
}
