/** Report dispatcher: writes every enabled format into the output directory. */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReconReport, ReportFormat } from '../types.js';
import type { Logger } from '../utils/logger.js';
import { writeJsonReport, FORMAT_FILENAMES } from './json.js';
import { renderMarkdown, scorecardSummary, writeMarkdownReport } from './markdown.js';
import { renderHtml } from './html.js';
import { writePdfReport } from './pdf.js';
import { writeOpenApiReport } from './openapi.js';
import { writeDashboardReport } from './dashboard.js';
import { writeShareReport } from './share.js';

export async function writeReports(
  report: ReconReport,
  formats: ReportFormat[],
  outDir: string,
  logger?: Logger,
): Promise<string[]> {
  const files: string[] = [];

  if (formats.includes('json')) {
    files.push(await writeJsonReport(report, outDir));
  }

  const needsMarkdown = formats.includes('md') || formats.includes('html') || formats.includes('pdf');
  const markdown = needsMarkdown ? renderMarkdown(report) : null;

  if (formats.includes('md') && markdown) {
    files.push(await writeMarkdownReport(markdown, outDir));
  }

  const needsHtml = formats.includes('html') || formats.includes('pdf');
  const html =
    needsHtml && markdown
      ? await renderHtml(markdown, `API recon — ${report.meta.seedUrl}`, report)
      : null;

  if (formats.includes('html') && html) {
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, FORMAT_FILENAMES.html);
    await writeFile(file, html, 'utf8');
    files.push(file);
  }

  if (formats.includes('pdf') && html) {
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, FORMAT_FILENAMES.pdf);
    const ok = await writePdfReport(html, file, {
      seedUrl: report.meta.seedUrl,
      startedAt: report.meta.startedAt,
      toolVersion: report.meta.apiReconVersion,
      schemaVersion: report.schemaVersion,
      summary: scorecardSummary(report),
    });
    if (ok) files.push(file);
    else {
      logger?.warn(
        'PDF generation failed — skipping report.pdf. Rendering always needs Chromium ' +
          '(`npx playwright install chromium`), even when the scan ran in Firefox or WebKit. ' +
          'The other formats were still written.',
      );
    }
  }

  if (formats.includes('openapi')) {
    files.push(await writeOpenApiReport(report, outDir));
  }

  // Rendered from the report itself rather than from the Markdown: it is an
  // interactive view, not a printable one.
  if (formats.includes('dashboard')) {
    files.push(await writeDashboardReport(report, outDir));
  }

  // The share-safe summary, which reads only sample-free fields — the reason it
  // can be written without the full reports (see `--share`).
  if (formats.includes('share')) {
    files.push(await writeShareReport(report, outDir));
  }

  return files;
}
