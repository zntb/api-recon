/** JSON reporter — the machine-readable source of truth. */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReconReport, ReportFormat } from '../types.js';

export const FORMAT_FILENAMES: Record<ReportFormat, string> = {
  json: 'report.json',
  md: 'report.md',
  html: 'report.html',
  pdf: 'report.pdf',
  openapi: 'openapi.yaml',
  dashboard: 'dashboard.html',
};

export async function writeJsonReport(report: ReconReport, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const file = join(outDir, FORMAT_FILENAMES.json);
  await writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}
