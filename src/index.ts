/**
 * api-recon public API.
 *
 *   import { scan } from 'api-recon';
 *   const result = await scan({ url: 'https://example.com', depth: 2 });
 *   console.log(result.endpoints);
 *   await result.writeReports('./out');
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CapturedCall,
  CapturedPage,
  ReconReport,
  ReportFormat,
  ScanEvent,
  ScanHandle,
  ScanOptions,
  ScanProgressState,
  ScanResult,
} from './types.js';
import { ALL_REPORT_FORMATS, REPORT_FORMATS, REPORT_SCHEMA_VERSION } from './types.js';
import { TOOL_VERSION } from './version.js';
import { createEventHandle } from './core/events.js';
import { launchSession, resolveEngine } from './core/browser.js';
import { TrafficInterceptor } from './core/interceptor.js';
import { crawl } from './core/crawler.js';
import { runActions, loadActions } from './core/actions.js';
import { loadLoginFlow, runLoginFlow, validateStorageState } from './core/authenticator.js';
import { runRecordSession } from './core/record.js';
import { analyzeCalls, analyzeWebSockets } from './core/analyzer.js';
import { ScanScope } from './core/scope.js';
import { verifyRedaction } from './core/verifyRedaction.js';
import {
  readSignKeyFile,
  resolveIntegrityAlgorithm,
  writeIntegrityManifest,
} from './utils/integrity.js';
import { SecretLedger } from './utils/redactionLedger.js';
import { groupResources } from './core/resources.js';
import { diffReports, loadBaseline } from './core/diff.js';
import { collectFindings } from './core/findings.js';
import { buildTelemetry, resolveTelemetryPlan, writeTelemetryFile } from './core/telemetry.js';
import { detectTechnologies, type TechEvidence } from './core/techStack.js';
import { writeReports } from './reporters/index.js';
import { writeJsonReport } from './reporters/json.js';
import {
  checkpointPath,
  readScanCheckpoint,
  removeScanCheckpoint,
  SCAN_CHECKPOINT_VERSION,
  writeScanCheckpoint,
} from './core/checkpoint.js';
import { fetchRobots } from './utils/robots.js';
import { isPrivateHost, normalizeUrl } from './utils/url.js';
import { RateLimiter } from './utils/rateLimit.js';
import { Logger } from './utils/logger.js';
import { SafetyError, assertScanAllowed } from './utils/safety.js';
import { ApiReconError, CancelledError, RuntimeError } from './utils/errors.js';
import { attachDebugInfo } from './utils/debug.js';

/**
 * Run a scan. The result is a promise of the report that is also an async
 * iterator of events, so a caller can either `await` it or stream it — against
 * one scan, not two:
 *
 *   const result = await scan({ url: 'https://example.com' });
 *
 *   for await (const event of scan({ url: 'https://example.com' })) {
 *     if (event.type === 'endpoint') console.log(event.endpoint.id);
 *   }
 */
export function scan(options: ScanOptions): ScanHandle {
  return createEventHandle<ScanResult, ScanEvent>(
    (emit) => runScan(options, emit),
    (result) => ({ type: 'done', result }),
  );
}

async function runScan(
  options: ScanOptions,
  emit: (event: ScanEvent) => void,
): Promise<ScanResult> {
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
  const strictRedaction = options.strictRedaction ?? false;
  // Collects what redaction removes, so the built report can be checked for
  // those values before anything is written. Memory-only, never persisted.
  const ledger = new SecretLedger();
  const telemetryPlan = resolveTelemetryPlan(options);
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const debug = options.debug ?? false;
  const debugDir = options.debugDir;
  const formats = normalizeFormats(options.formats);
  // Validated up front so a typo fails before any network or browser work.
  const engine = resolveEngine(options.browser);
  const logger = options.logger ?? new Logger({ quiet: options.quiet, verbose: options.verbose });
  // The integrity manifest is resolved here as well: a typo in the algorithm or
  // a missing key file should fail in milliseconds, not after a crawl. Signing
  // implies checksumming, with sha256 unless one was named.
  const integrityAlgorithm =
    resolveIntegrityAlgorithm(options.checksum) ?? (options.signKey ? 'sha256' : null);
  const signKey = options.signKey ? await readSignKeyFile(options.signKey) : undefined;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const resume = options.resume ?? false;
  if (resume && !options.out) {
    throw new SafetyError('--resume needs an output directory to read the checkpoint from.', {
      hint: 'Pass --out <dir>, or start a fresh scan without --resume.',
    });
  }
  const checkpointFile = options.out ? checkpointPath(options.out) : null;
  // Loaded before the browser launches, so a missing or mismatched checkpoint
  // fails in milliseconds rather than after a crawl.
  const resumed = resume && checkpointFile ? await readScanCheckpoint(checkpointFile) : null;
  if (resumed && checkpointFile && normalizeUrl(resumed.seedUrl) !== normalizeUrl(seedUrl)) {
    throw new SafetyError(
      `The checkpoint at ${checkpointFile} is for ${resumed.seedUrl}, not ${seedUrl}.`,
      { hint: 'Pass the same seed URL, or start a fresh scan without --resume.' },
    );
  }
  // A signal that is already aborted stops the run before a browser is ever
  // launched, rather than opening one only to close it.
  const signal = options.signal;
  if (signal?.aborted) {
    throw new CancelledError('The scan was cancelled before it started.');
  }

  assertScanAllowed(seedUrl, { allowLocal });
  // Every host the crawl may follow, and every path it must skip. An included
  // host goes through the same local-address guard as the seed, so the flag
  // cannot smuggle in a private target.
  for (const host of options.includeHost ?? []) {
    if (isPrivateHost(host) && !allowLocal) {
      throw new SafetyError(
        `Refusing to include private/local host ${host} — pass --allow-local to include it.`,
        { hint: 'Add --allow-local if this host is a machine you own or may test.' },
      );
    }
  }
  const scope = new ScanScope(seedUrl, options.includeHost, options.excludePath);
  const origin = new URL(seedUrl).origin;
  // A resumed run keeps the original start time, so its report spans the whole
  // capture rather than only the part after the resume.
  const startedAt = resumed ? resumed.startedAt : Date.now();

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
          { hint: 'Re-run with --force only if you are authorized to test this system.' },
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
  const storageState = options.auth ? await validateStorageState(options.auth, logger) : null;
  const loginFlow = options.login ? await loadLoginFlow(options.login) : null;
  const actionSteps = options.actions ? await loadActions(options.actions) : [];

  const record = options.record ?? false;
  // Record mode is headed for humans; API_RECON_HEADLESS=1 keeps it testable.
  const headless = record ? process.env.API_RECON_HEADLESS === '1' : true;

  const session = await launchSession({ headless, storageState, engine, trace: debug });
  const interceptor = new TrafficInterceptor({
    redact,
    maxBodyBytes,
    includeThirdParty,
    seedUrl,
    scope,
    ...(options.maxWebSocketFrames !== undefined
      ? { maxWebSocketFrames: options.maxWebSocketFrames }
      : {}),
    ...(options.maxCalls !== undefined ? { maxCalls: options.maxCalls } : {}),
    ...(options.maxWebSockets !== undefined ? { maxWebSockets: options.maxWebSockets } : {}),
    // Spill oversized bodies beside the reports; with no output directory there
    // is nowhere to put them, so they are only truncated in memory.
    ...(options.out ? { payloadDir: join(options.out, 'payloads') } : {}),
    onSecret: (value) => ledger.add(value),
  });
  interceptor.attach(session.page);
  session.context.on('page', (page) => interceptor.attach(page));
  // A resumed scan continues one report, so the traffic captured before the
  // checkpoint is seeded back into the interceptor.
  if (resumed) interceptor.restore({ calls: resumed.calls, webSockets: resumed.webSockets });

  // A SIGINT/SIGTERM must not leave a Chromium process behind. Closing the
  // session the moment the signal arrives unblocks any in-flight navigation so
  // teardown starts at once; the `finally` below closes it again as a no-op, so
  // the browser is closed whether the run was cancelled or finished normally.
  let interrupted = false;
  const onAbort = (): void => {
    if (interrupted) return;
    interrupted = true;
    logger.warn('Interrupted — closing the browser and flushing a partial report.');
    void session.close();
  };
  if (signal) {
    signal.addEventListener('abort', onAbort, { once: true });
    // The signal may have aborted while the browser was starting, before this
    // listener existed. An AbortSignal does not replay the event for a listener
    // attached afterwards, so check the flag too and treat a late signal as the
    // interruption it is rather than crawling on and finishing as if nothing
    // happened.
    if (signal.aborted) onAbort();
  }

  const evidence: TechEvidence[] = resumed ? resumed.evidence : [];
  let pages: CapturedPage[] = resumed ? resumed.pages : [];
  let blockedByRobots: string[] = resumed ? resumed.blockedByRobots : [];

  // Progress is push-based and purely observational: the reporters (the
  // onProgress callback and the event stream) decide how to use it, and never
  // get a say in what the scan does.
  let lastPhase: ScanProgressState['phase'] | null = null;
  let emittedPages = 0;
  const publishProgress = (phase: ScanProgressState['phase']): void => {
    if (options.onProgress) {
      try {
        options.onProgress({
          phase,
          seedUrl,
          pages,
          maxPages,
          calls: interceptor.calls,
          startedAt,
        });
      } catch {
        // A reporter that throws is a reporter's problem, not the scan's.
      }
    }
    // The event stream gets a phase event when the phase actually changes and a
    // page event for every page recorded since the last call.
    if (phase !== lastPhase) {
      lastPhase = phase;
      emit({ type: 'phase', phase });
    }
    while (emittedPages < pages.length) {
      emit({ type: 'page', page: pages[emittedPages]! });
      emittedPages += 1;
    }
  };

  publishProgress(record ? 'recording' : 'crawling');

  /**
   * Build the report from whatever has been captured. On success this is the
   * final report; when a run fails it is the partial report `--debug` saves, so
   * a bug report shows what the crawl saw before it broke.
   */
  const buildReport = (): ReconReport => {
    const captures = interceptor.calls.slice();
    const webSockets = analyzeWebSockets(interceptor.webSockets);
    const endpoints = analyzeCalls(captures, {
      seedUrl,
      redact,
      onSecret: (value) => ledger.add(value),
    });
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
    return report;
  };

  let failure: unknown = null;
  let tracePath: string | undefined;

  try {
    if (loginFlow) await runLoginFlow(session.context, loginFlow, logger);

    if (record) {
      pages = await runRecordSession({
        page: session.page,
        seedUrl,
        logger,
        maxPages,
        onPage: () => publishProgress('recording'),
      });
    } else {
      const outcome = await crawl(session.page, {
        seedUrl,
        maxDepth: depth,
        maxPages,
        limiter,
        robots,
        scope,
        logger,
        navTimeoutMs: timeoutMs,
        ...(signal ? { signal } : {}),
        ...(resumed
          ? {
              initial: {
                queue: resumed.queue,
                visited: resumed.visited,
                seenPages: resumed.seenPages,
                pages: resumed.pages,
                blockedByRobots: resumed.blockedByRobots,
              },
            }
          : {}),
        // Written after every page, so a crash or Ctrl+C leaves a usable
        // starting point rather than throwing the run away.
        onCheckpoint: async (state) => {
          // The crawler owns the pages until it returns, and an interrupted
          // crawl may never return — it can throw on the aborted navigation
          // instead. Recording them here means the partial report built after
          // a Ctrl+C still describes the pages the crawl did visit, rather than
          // claiming it visited none.
          pages = state.pages;
          blockedByRobots = state.blockedByRobots;
          if (!checkpointFile) return;
          await writeScanCheckpoint(checkpointFile, {
            version: SCAN_CHECKPOINT_VERSION,
            seedUrl,
            engine,
            startedAt,
            ...state,
            calls: interceptor.calls,
            webSockets: interceptor.webSockets,
            evidence,
          });
        },
        onPageVisited: () => publishProgress('crawling'),
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
  } catch (err) {
    failure = err;
  } finally {
    // The listener has served its purpose and must not outlive the run.
    if (signal) signal.removeEventListener('abort', onAbort);
    // A trace is only kept for a failure; on a run that succeeds it is
    // discarded, so --debug costs nothing when nothing goes wrong.
    if (debug) {
      if (failure && debugDir) {
        tracePath = join(debugDir, 'trace.zip');
        await mkdir(debugDir, { recursive: true }).catch(() => {});
        await session.context.tracing.stop({ path: tracePath }).catch(() => {});
      } else {
        await session.context.tracing.stop().catch(() => {});
      }
    }
    await session.close();
  }

  // Payloads being spilled to disk must exist before a report references them.
  await interceptor.flush();
  if (interceptor.droppedCalls > 0) {
    logger.warn(
      `Capture cap reached: ${interceptor.droppedCalls} call(s) past the cap were counted but not stored.`,
    );
  }
  if (interceptor.droppedSockets > 0) {
    logger.warn(
      `WebSocket cap reached: ${interceptor.droppedSockets} connection(s) were counted but not stored.`,
    );
  }

  if (interrupted) {
    // Cancelled on request: flush what the crawl had as report.json, so an
    // interrupted run is still worth something, and leave the checkpoint in
    // place so `--resume` can pick the crawl up where it stopped. This is a
    // deliberate stop, so it rejects with CancelledError rather than a failure.
    const report = buildReport();
    if (options.out) {
      try {
        const file = await writeJsonReport(report, options.out);
        logger.warn(
          `Partial report written to ${file} (${report.meta.pagesVisited} page(s), ` +
            `${report.endpoints.length} endpoint pattern(s)).`,
        );
      } catch (err) {
        logger.warn(
          `could not flush the partial report: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    throw new CancelledError('The scan was cancelled.', {
      hint: options.out
        ? `Re-run with --resume to continue from ${checkpointFile ?? options.out}.`
        : 'Pass --out <dir> to keep a partial report and a checkpoint you can resume.',
    });
  }

  if (failure) {
    // A scan that started and then failed is a RuntimeError; a deliberate error
    // (a login step's SafetyError, say) passes through untouched, so its own
    // type and hint survive.
    const error =
      failure instanceof ApiReconError
        ? failure
        : new RuntimeError(failure instanceof Error ? failure.message : String(failure), {
            cause: failure,
          });

    // Best-effort: a diagnostic bundle must never replace the real failure.
    if (debug && debugDir) {
      try {
        const partialPath = join(debugDir, 'partial-report.json');
        await mkdir(debugDir, { recursive: true });
        await writeFile(partialPath, `${JSON.stringify(buildReport(), null, 2)}\n`, 'utf8');
        attachDebugInfo(error, {
          dir: debugDir,
          ...(tracePath ? { trace: tracePath } : {}),
          partialReport: partialPath,
        });
      } catch {
        /* the bundle is optional; the scan's own error is what matters */
      }
    }
    throw error;
  }

  publishProgress('analyzing');

  const report = buildReport();
  const captures: CapturedCall[] = interceptor.calls.slice();

  // Stream each grouped endpoint, so an embedding app can render the list as it
  // fills in rather than waiting for the whole report.
  for (const endpoint of report.endpoints) emit({ type: 'endpoint', endpoint });

  if (baseline) report.diff = diffReports(baseline, report);

  // Redaction is proved, not assumed: search the finished report for any value
  // the capture layer removed. A hit means it survived in a field the redactors
  // never touch, so warn — or, under --strict-redaction, refuse to write it.
  const verification = verifyRedaction(report, ledger);
  if (verification.total > 0) {
    const paths = verification.paths.join(', ');
    const more =
      verification.total > verification.paths.length
        ? `, +${verification.total - verification.paths.length} more`
        : '';
    const message =
      `Redaction check: ${verification.total} report field(s) still contain a value ` +
      `that should have been removed (${paths}${more}).`;
    if (strictRedaction) {
      throw new SafetyError(`${message} Refusing to write the reports.`, {
        hint: 'Re-run without --strict-redaction to write them anyway, or report this as a bug.',
      });
    }
    logger.warn(`${message} Writing them anyway — pass --strict-redaction to refuse.`);
  }

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
    if (integrityAlgorithm) {
      written.push(
        await writeIntegrityManifest([...written, ...interceptor.payloadFiles], outDir, {
          algorithm: integrityAlgorithm,
          ...(signKey ? { key: signKey } : {}),
        }),
      );
    }
    return written;
  };

  let files: string[] = [];
  if (options.out) files = await writeReportsTo(options.out);
  // The run completed, so the checkpoint has done its job; only a run that
  // stopped early leaves one behind for --resume.
  if (checkpointFile) await removeScanCheckpoint(checkpointFile).catch(() => {});

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
    share: 'share',
  };
  if (!formats || formats.length === 0) return [...REPORT_FORMATS];
  const out: ReportFormat[] = [];
  for (const raw of formats) {
    const key = raw.trim().toLowerCase();
    const resolved = aliases[key];
    if (!resolved) {
      throw new SafetyError(
        `Unknown report format '${raw}'. Valid formats: ${ALL_REPORT_FORMATS.join(', ')}.`,
      );
    }
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

export { SafetyError } from './utils/safety.js';
// The typed error classes the library reference documents, so a host
// application can tell a refusal from a failure and read the shared `hint`.
export { ApiReconError, CancelledError, RuntimeError } from './utils/errors.js';
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
  ScanEvent,
  ScanHandle,
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
export {
  buildIntegrityManifest,
  verifyIntegrityManifest,
  verifyManifestFromDisk,
  INTEGRITY_ALGORITHMS,
  INTEGRITY_FILENAME,
} from './utils/integrity.js';
export type {
  IntegrityAlgorithm,
  IntegrityManifest,
  IntegrityVerification,
} from './utils/integrity.js';
export {
  TELEMETRY_PAYLOAD_KEYS,
  TELEMETRY_SIGNAL_KEYS,
  telemetryBoundaryViolations,
} from './core/telemetry.js';
export { SCAN_CHECKPOINT_FILENAME, checkpointPath, readScanCheckpoint } from './core/checkpoint.js';
export { collectFindings } from './core/findings.js';
export { groupResources } from './core/resources.js';
export { buildRequestGraph } from './reporters/graph.js';
export {
  ALL_REPORT_FORMATS,
  REPORT_FORMATS,
  REPORT_SCHEMA_VERSION,
  CATEGORIES,
  BROWSER_ENGINES,
} from './types.js';
