/**
 * api-recon public API.
 *
 *   import { scan } from 'api-recon';
 *   const result = await scan({ url: 'https://example.com', depth: 2 });
 *   console.log(result.endpoints);
 *   await result.writeReports('./out');
 */

import type { CapturedCall, CapturedPage, ReconReport, ReportFormat, ScanOptions, ScanResult } from './types.js';
import { REPORT_FORMATS, REPORT_SCHEMA_VERSION } from './types.js';
import { TOOL_VERSION } from './version.js';
import { launchSession, resolveEngine } from './core/browser.js';
import { TrafficInterceptor } from './core/interceptor.js';
import { crawl } from './core/crawler.js';
import { runActions, loadActions } from './core/actions.js';
import { loadLoginFlow, runLoginFlow, validateStorageState } from './core/authenticator.js';
import { runRecordSession } from './core/record.js';
import { analyzeCalls, analyzeWebSockets } from './core/analyzer.js';
import { groupResources } from './core/resources.js';
import { diffReports, loadBaseline } from './core/diff.js';
import { collectFindings } from './core/findings.js';
import { buildTelemetry, resolveTelemetryPlan, writeTelemetryFile } from './core/telemetry.js';
import { detectTechnologies, type TechEvidence } from './core/techStack.js';
import { writeReports } from './reporters/index.js';
import { fetchRobots } from './utils/robots.js';
import { RateLimiter } from './utils/rateLimit.js';
import { Logger } from './utils/logger.js';
import { SafetyError, assertScanAllowed } from './utils/safety.js';

export async function scan(options: ScanOptions): Promise<ScanResult> {
  if (!options?.url) {
    throw new SafetyError('A seed URL is required, e.g. scan({ url: "https://example.com" }).');
  }
  const seedUrl = options.url;
  const allowLocal = options.allowLocal ?? false;
  const depth = options.depth ?? 1;
  const maxPages = options.maxPages ?? 25;
  const respectRobots = options.respectRobots ?? true;
  const force = options.force ?? false;
  const includeThirdParty = options.includeThirdParty ?? false;
  const redact = options.redact ?? true;
  const telemetryPlan = resolveTelemetryPlan(options);
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const formats = normalizeFormats(options.formats);
  // Validated up front so a typo fails before any network or browser work.
  const engine = resolveEngine(options.browser);
  const logger = options.logger ?? new Logger({ quiet: options.quiet, verbose: options.verbose });

  assertScanAllowed(seedUrl, { allowLocal });
  const origin = new URL(seedUrl).origin;
  const startedAt = Date.now();

  // ---- robots.txt ---------------------------------------------------------
  let robots: { isAllowed: (path: string, userAgent?: string) => boolean } | null = null;
  let effectiveRate = options.rate ?? 500;
  if (respectRobots) {
    const robotsFile = await fetchRobots(origin);
    if (robotsFile.rules.crawlDelaySeconds) {
      effectiveRate = Math.max(effectiveRate, robotsFile.rules.crawlDelaySeconds * 1000);
      logger.debug(`robots.txt crawl-delay raised the request interval to ${effectiveRate}ms`);
    }
    if (force) {
      logger.warn('--force: robots.txt restrictions are being ignored.');
    } else {
      const seedPath = new URL(seedUrl).pathname;
      if (!robotsFile.isAllowed(seedPath)) {
        throw new SafetyError(
          `robots.txt disallows ${seedPath} on ${origin}. Re-run with --force to override (at your own risk).`,
        );
      }
      robots = robotsFile;
    }
  } else {
    logger.warn('robots.txt compliance disabled (respectRobots: false).');
  }

  // ---- prepare inputs -----------------------------------------------------
  // Load the baseline before launching a browser: a bad path should fail in
  // milliseconds, not after a full crawl.
  const baseline = options.diff ? await loadBaseline(options.diff) : null;
  const limiter = new RateLimiter({ delayMs: effectiveRate });
  const storageState = options.auth ? await validateStorageState(options.auth) : null;
  const loginFlow = options.login ? await loadLoginFlow(options.login) : null;
  const actionSteps = options.actions ? await loadActions(options.actions) : [];

  const record = options.record ?? false;
  // Record mode is headed for humans; API_RECON_HEADLESS=1 keeps it testable.
  const headless = record ? process.env.API_RECON_HEADLESS === '1' : true;

  const session = await launchSession({ headless, storageState, engine });
  const interceptor = new TrafficInterceptor({
    redact,
    maxBodyBytes,
    includeThirdParty,
    seedUrl,
  });
  interceptor.attach(session.page);
  session.context.on('page', (page) => interceptor.attach(page));

  const evidence: TechEvidence[] = [];
  let pages: CapturedPage[] = [];
  let blockedByRobots: string[] = [];

  try {
    if (loginFlow) await runLoginFlow(session.context, loginFlow, logger);

    if (record) {
      pages = await runRecordSession({ page: session.page, seedUrl, logger });
    } else {
      const outcome = await crawl(session.page, {
        seedUrl,
        maxDepth: depth,
        maxPages,
        limiter,
        robots,
        logger,
        ...(actionSteps.length
          ? { runActions: (page) => runActions(page, actionSteps, logger) }
          : {}),
        onPageLoaded: async (page, html, _depth, headers) => {
          const cookies = await session.context
            .cookies(page.url())
            .then((cs) => cs.map((c) => c.name))
            .catch(() => []);
          const scripts = await page
            .evaluate(() =>
              Array.from(document.querySelectorAll('script[src]')).map(
                (s) => (s as HTMLScriptElement).src,
              ),
            )
            .catch(() => []);
          evidence.push({ url: page.url(), headers, html, cookies, scripts });
        },
      });
      pages = outcome.pages;
      blockedByRobots = outcome.blockedByRobots;
    }
  } finally {
    await session.close();
  }

  const captures: CapturedCall[] = interceptor.calls.slice();
  const webSockets = analyzeWebSockets(interceptor.webSockets);
  const endpoints = analyzeCalls(captures, { seedUrl });
  const technologies = detectTechnologies(evidence);

  const report: ReconReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    meta: {
      seedUrl,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      pagesVisited: pages.length,
      apiReconVersion: TOOL_VERSION,
      engine,
    },
    technologies,
    endpoints,
    resources: groupResources(endpoints),
    pages,
    webSockets,
    safety: {
      robotsRespected: respectRobots && !force,
      robotsSkippedPaths: blockedByRobots,
      rateLimitMs: effectiveRate,
      maxBodyBytes,
      allowLocal,
      redact,
    },
  };

  report.findings = collectFindings(report);

  if (baseline) report.diff = diffReports(baseline, report);

  // A preview builds the payload so the caller can inspect it, but only an
  // explicit opt-in writes it to disk.
  const telemetry = telemetryPlan.build ? buildTelemetry(report, captures) : undefined;
  if (telemetry) {
    logger.info(
      (telemetryPlan.write
        ? 'Telemetry enabled: writing anonymized categorization signals only — '
        : 'Telemetry preview: building anonymized categorization signals only — ') +
        'no host, path, query, header, or body data.',
    );
  }

  const writeReportsTo = async (outDir: string): Promise<string[]> => {
    const written = await writeReports(report, formats, outDir, logger);
    if (telemetry && telemetryPlan.write) written.push(await writeTelemetryFile(telemetry, outDir));
    return written;
  };

  let files: string[] = [];
  if (options.out) files = await writeReportsTo(options.out);

  return {
    report,
    writeReports: writeReportsTo,
    files,
    ...(report.diff ? { diff: report.diff } : {}),
    ...(telemetry ? { telemetry } : {}),
  };
}

export function normalizeFormats(formats: readonly string[] | undefined): ReportFormat[] {
  const aliases: Record<string, ReportFormat> = {
    markdown: 'md',
    yaml: 'openapi',
    json: 'json',
    md: 'md',
    html: 'html',
    pdf: 'pdf',
    openapi: 'openapi',
    dashboard: 'dashboard',
    dash: 'dashboard',
  };
  if (!formats || formats.length === 0) return [...REPORT_FORMATS];
  const out: ReportFormat[] = [];
  for (const raw of formats) {
    const key = raw.trim().toLowerCase();
    const resolved = aliases[key];
    if (!resolved) {
      throw new SafetyError(
        `Unknown report format '${raw}'. Valid formats: ${REPORT_FORMATS.join(', ')}.`,
      );
    }
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

export { SafetyError } from './utils/safety.js';
export { Logger } from './utils/logger.js';
export type {
  BrowserEngine,
  CacheInfo,
  CapturedCall,
  ChangeKind,
  EndpointChange,
  CapturedPage,
  CategorizationHeuristic,
  Category,
  CapturedWebSocket,
  Endpoint,
  Finding,
  FindingKind,
  FindingSeverity,
  GraphQLInfo,
  GraphQLOperation,
  GraphQLOperationType,
  JsonSchemaLike,
  PercentileStats,
  QueryParam,
  ReconReport,
  ReportDiff,
  ReportFormat,
  Resource,
  ResourceEndpoint,
  ScanOptions,
  ScanResult,
  ScanRef,
  Technology,
  TelemetryPayload,
  TelemetrySignal,
  VendorAttribution,
  WebSocketDirection,
  WebSocketFrame,
} from './types.js';
export { diffReports, loadBaseline, formatDiffSummary } from './core/diff.js';
export { collectFindings } from './core/findings.js';
export { groupResources } from './core/resources.js';
export { buildRequestGraph } from './reporters/graph.js';
export { REPORT_FORMATS, REPORT_SCHEMA_VERSION, CATEGORIES, BROWSER_ENGINES } from './types.js';
