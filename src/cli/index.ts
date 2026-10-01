#!/usr/bin/env node
/** api-recon CLI. */

import { realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { Command, InvalidArgumentError } from 'commander';
import { BROWSER_ENGINES, formatDiffSummary, normalizeFormats, scan } from '../index.js';
import { resolveEngine } from '../core/browser.js';
import { CONFIG_FILENAMES, PRINT_FORMATS } from './config.js';
import { COMPLETION_SHELLS, completionScript, isCompletionShell } from './completion.js';
import {
  baselineExists,
  findBaseline,
  isLatestBaseline,
  resolveBaselinePath,
  writeBaseline,
} from './baseline.js';
import { openFile } from '../utils/open.js';
import { renderOpenApi } from '../reporters/openapi.js';
import { renderMarkdown } from '../reporters/markdown.js';
import { renderShareSummary } from '../reporters/share.js';
import { renderHtml } from '../reporters/html.js';
import type { ReconReport } from '../types.js';
import { presetHelp } from './presets.js';
import { formatTelemetry, resolveTelemetryPlan } from '../core/telemetry.js';
import type { BrowserEngine } from '../types.js';
import { showBannerOnce } from '../utils/banner.js';
import { Logger } from '../utils/logger.js';
import { LiveProgress, progressModeFor } from '../utils/progress.js';
import { resolveOptions } from './config.js';
import { SafetyError } from '../utils/safety.js';
import { hintForError } from '../utils/errors.js';
import { debugInfoFor } from '../utils/debug.js';
import { formatDuration } from '../utils/misc.js';
import { TOOL_VERSION } from '../version.js';

function intArg(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < 0) throw new InvalidArgumentError(`Expected a non-negative integer, got "${value}"`);
  return n;
}

function numberArg(value: string): number {
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) throw new InvalidArgumentError(`Expected a non-negative number, got "${value}"`);
  return n;
}

function engineArg(value: string): BrowserEngine {
  try {
    return resolveEngine(value);
  } catch {
    throw new InvalidArgumentError(
      `Expected one of: ${BROWSER_ENGINES.join(', ')}, got "${value}"`,
    );
  }
}

/**
 * The scan flags, added to both the default command and the `baseline`
 * subcommand. Each command carries its own copy so `api-recon baseline <url>
 * --depth 0` parses the same way `api-recon <url> --depth 0` does; commander's
 * positional-option mode keeps the two sets from colliding.
 */
function registerScanOptions(command: Command): Command {
  return command
    .option('-d, --depth <n>', 'same-domain crawl depth (0 = seed page only)', intArg, 1)
    .option('-m, --max-pages <n>', 'hard cap on pages visited', intArg, 25)
    .option('--open', 'open the dashboard in your browser when the scan finishes', false)
    .option(
      '--share',
      'write a share-safe one-page summary (share.md) instead of the full reports — no bodies, headers, or samples',
      false,
    )
    .option(
      '--print [format]',
      `print a report to stdout as well as writing files (${PRINT_FORMATS.join(', ')}; default md). Human output moves to stderr, so it pipes cleanly`,
    )
    .option(
      '--preset <name>',
      `bundle the flags for a common case — ${presetHelp()}. A flag or an environment variable still wins`,
    )
    .option(
      '--config <file>',
      `path to a project config file (default: the nearest ${CONFIG_FILENAMES.join(' / ')} up from the working directory)`,
    )
    .option('--no-config', 'ignore any project config file, even one found on the way up')
    .option('-o, --out <dir>', 'output directory for reports', './api-recon-output')
    .option(
      '-f, --formats <list>',
      'comma-separated report formats (json,md,html,pdf,openapi,dashboard,share)',
      'json,md,html,pdf,openapi,dashboard',
    )
    .option(
      '-b, --browser <engine>',
      `Playwright engine to drive (${BROWSER_ENGINES.join(', ')})`,
      engineArg,
      'chromium',
    )
    .option('-a, --auth <file>', 'path to a Playwright storageState.json for an authenticated session')
    .option('-l, --login <file>', 'path to a login-flow config (YAML/JSON) with ${ENV_VAR} substitution')
    .option('--record', 'interactive recording mode: drive the browser yourself, type "done" to finish', false)
    .option('--actions <file>', 'path to scripted interaction steps (YAML/JSON)')
    .option('-r, --rate <ms>', 'minimum delay between requests to the same origin', intArg, 500)
    .option('--respect-robots', 'respect robots.txt (default)', true)
    .option('--no-respect-robots', 'ignore robots.txt (requires --force to acknowledge ownership)')
    .option(
      '--diff <file>',
      'compare this scan against a previous report.json — or the stored baseline with `--diff latest`',
    )
    .option(
      '--baseline <file>',
      'override where the stored baseline lives (used by the `baseline` subcommand and `--diff latest`)',
    )
    .option('--fail-on-diff', 'with --diff, exit 3 when any endpoint changed (for CI gating)', false)
    .option('--include-third-party', 'capture cross-origin XHR/fetch calls as well', false)
    .option('--redact', 'redact sensitive headers such as Authorization and Cookie (default)', true)
    .option('--no-redact', 'disable header redaction (not recommended)')
    .option('--force', 'bypass robots.txt restrictions (only for systems you are allowed to test)', false)
    .option('--allow-local', 'allow scanning localhost and private network ranges', false)
    .option(
      '--telemetry',
      'write anonymized categorization signals to telemetry.json (off by default; no host, path, or body data)',
      false,
    )
    .option(
      '--telemetry-preview',
      'print the anonymized telemetry payload to stdout instead of writing telemetry.json',
      false,
    )
    .option('--max-body-mb <n>', 'maximum response body / WebSocket frame size to keep, in MB', numberArg, 1)
    .option('-q, --quiet', 'suppress progress output (errors only)', false)
    .option('-v, --verbose', 'verbose progress output', false)
    .option(
      '--json-progress',
      'emit progress as JSON lines on stdout (one object per event) instead of a live table',
      false,
    )
    .option(
      '--debug',
      'on failure, write a diagnostic bundle (logs, browser trace, and the partial report) for a bug report',
      false,
    );
}

const program = new Command();

program
  .name('api-recon')
  .description(
    'Discover a website\'s APIs by driving a headless browser, simulating user actions, and exporting a categorized report (JSON, Markdown, HTML, PDF, OpenAPI, interactive dashboard).',
  )
  .version(TOOL_VERSION)
  // The default command and the `baseline` subcommand both declare the scan
  // flags, so positional-option parsing is needed to keep the two sets apart.
  .enablePositionalOptions();

registerScanOptions(
  program.argument('<seedUrl>', 'URL to start from, e.g. https://example.com'),
).action(function (this: Command, seedUrl: string, raw: CliOptions) {
  return runScan(this, seedUrl, raw, false);
});

registerScanOptions(
  program
    .command('baseline <seedUrl>')
    .description(
      'scan and save the report as the stored baseline for `--diff latest`, so CI need not manage a path',
    ),
).action(function (this: Command, seedUrl: string, raw: CliOptions) {
  return runScan(this, seedUrl, raw, true);
});

program
  .command('completion <shell>')
  .description(
    `print a shell completion script for ${COMPLETION_SHELLS.join(', ')} — ` +
      'install it once and the flags stop being something to remember',
  )
  .action((shell: string) => {
    if (!isCompletionShell(shell)) {
      const logger = new Logger({});
      logger.error(
        `Unknown shell "${shell}". Supported shells: ${COMPLETION_SHELLS.join(', ')}.`,
      );
      logger.always(
        `  ${chalk.cyan('→')} Try \`api-recon completion bash\` (or zsh, fish).`,
      );
      process.exitCode = 2;
      return;
    }
    process.stdout.write(completionScript(shell, program));
  });

interface CliOptions {
  depth: number;
  maxPages: number;
  out: string;
  formats: string;
  auth?: string;
  login?: string;
  record: boolean;
  actions?: string;
  rate: number;
  browser: BrowserEngine;
  diff?: string;
  /** Overrides the canonical baseline path for `baseline` and `--diff latest`. */
  baseline?: string;
  failOnDiff: boolean;
  respectRobots: boolean;
  includeThirdParty: boolean;
  redact: boolean;
  force: boolean;
  allowLocal: boolean;
  telemetry: boolean;
  telemetryPreview: boolean;
  maxBodyMb: number;
  quiet: boolean;
  verbose: boolean;
  jsonProgress: boolean;
  /** On failure, write a diagnostic bundle for a bug report. */
  debug: boolean;
  /** A path from --config, `false` from --no-config, absent when discovering. */
  config?: string | boolean;
  /** quick | deep | ci, when --preset was given. */
  preset?: string;
  /** Open the dashboard when the scan finishes. */
  open: boolean;
  /** Write only the share-safe summary, instead of the full reports. */
  share: boolean;
  /** `--print` (md) or the format it was given. */
  print?: string | boolean;
}

/**
 * The body shared by `api-recon <url>` and `api-recon baseline <url>`. The only
 * difference is that the latter saves its report as the canonical baseline,
 * which `--diff latest` later reads.
 */
async function runScan(
  command: Command,
  seedUrl: string,
  raw: CliOptions,
  isBaseline: boolean,
): Promise<void> {
  // Fold the command line, the environment, and any project config file into
  // one set of options before anything acts on them — so a guard like
  // --fail-on-diff is satisfied by a config file too, as its precedence
  // implies, and --quiet can come from the file.
  let opts = raw;
  let resolved: Awaited<ReturnType<typeof resolveOptions>>;
  try {
    resolved = await resolveOptions({
      // `--print` with no value is the default format, so the resolver only
      // ever sees a name and can validate it like any other setting.
      cli: { ...raw, ...(raw.print === true ? { print: 'md' } : {}) } as unknown as Record<
        string,
        unknown
      >,
      isExplicit: (key) => command.getOptionValueSource(key) === 'cli',
    });
    opts = resolved.options as unknown as CliOptions;
  } catch (err) {
    const logger = new Logger({ quiet: raw.quiet, verbose: raw.verbose });
    logger.error(err instanceof SafetyError ? err.message : String(err));
    logger.always(`  ${chalk.cyan('→')} ${hintForError(err)}`);
    process.exitCode = 2;
    return;
  }

  // With --print, stdout belongs to the report: every human line moves to
  // stderr, so `api-recon <url> --print md > report.md` holds only the report.
  const outStream: 'stdout' | 'stderr' = opts.print ? 'stderr' : 'stdout';
  // With --debug every line the logger emits is also kept for the bundle's log
  // file, so a bug report includes what the run printed.
  const debugLog: string[] | undefined = opts.debug ? [] : undefined;
  const logger = new Logger({
    quiet: opts.quiet,
    verbose: opts.verbose,
    stream: outStream,
    ...(debugLog ? { record: (line: string) => debugLog.push(line) } : {}),
  });
  showBannerOnce(logger);
  const from = (source: string): string =>
    Object.entries(resolved.provenance)
      .filter(([, value]) => value === source)
      .map(([key]) => key)
      .join(', ');
  if (resolved.configPath) logger.debug(`config: ${resolved.configPath}`);
  else if (resolved.configIgnored) logger.debug('config: ignored (--no-config)');
  if (from('preset')) logger.debug(`preset ${opts.preset}: ${from('preset')}`);
  if (from('config')) logger.debug(`from config: ${from('config')}`);
  if (from('env')) logger.debug(`from environment: ${from('env')}`);

  if (!opts.respectRobots && !opts.force) {
    logger.error(
      '--no-respect-robots requires --force, which acknowledges that you own or may test the target.',
    );
    logger.always(`  ${chalk.cyan('→')} Add --force if this target is one you are authorized to test.`);
    process.exitCode = 2;
    return;
  }

  if (opts.failOnDiff && !opts.diff) {
    logger.error('--fail-on-diff only means something together with --diff <file>.');
    logger.always(`  ${chalk.cyan('→')} Pass --diff <file> or --diff latest as well.`);
    process.exitCode = 2;
    return;
  }

  // `--diff latest` names the stored baseline rather than a file path. A typed
  // sentinel resolving here means a CI job names neither the directory nor the
  // file, and a missing baseline tells the user how to make one. An explicit
  // `--baseline` wins over the canonical discovery, so parallel runs can keep
  // separate baselines without touching the committed one.
  const explicitBaseline = opts.baseline?.trim() ? opts.baseline : undefined;
  if (isLatestBaseline(opts.diff)) {
    const target = explicitBaseline ?? (await findBaseline());
    if (!target || !(await baselineExists(target))) {
      logger.error(
        explicitBaseline
          ? `No baseline found at ${explicitBaseline}. Capture one first with ` +
              `\`api-recon baseline <url> --baseline ${explicitBaseline}\`.`
          : 'No stored baseline found. Capture one first with `api-recon baseline <url>`.',
      );
      process.exitCode = 2;
      return;
    }
    opts.diff = target;
    logger.debug(`baseline: ${target}`);
  }

  try {
    let formats = normalizeFormats(opts.formats.split(','));
    if (opts.share) {
      // Safe by construction: the share mode replaces the whole format set, so
      // a full report — which keeps redacted samples — can never be written
      // alongside the summary by accident.
      formats = ['share'];
    } else if (opts.open && !formats.includes('dashboard')) {
      // Opening the dashboard means it has to exist, whatever --formats said.
      formats.push('dashboard');
    }
    // Off unless asked for on the command line or in the environment.
    const telemetry = opts.telemetry || process.env.API_RECON_TELEMETRY === '1';
    const telemetryPlan = resolveTelemetryPlan({
      telemetry,
      telemetryPreview: opts.telemetryPreview,
    });
    const started = Date.now();
    // A terminal gets the running table; a pipe gets JSON only when asked for
    // it, and otherwise nothing — redrawn ANSI frames in a log file are noise.
    const progressStream = outStream === 'stderr' ? process.stderr : process.stdout;
    const progress = new LiveProgress({
      stream: progressStream,
      mode: progressModeFor({ json: opts.jsonProgress, quiet: opts.quiet, stream: progressStream }),
    });
    if (progress.mode === 'none') {
      logger.info(`Scanning ${chalk.bold(seedUrl)} (depth ${opts.depth}, max ${opts.maxPages} pages)`);
    }

    const result = await scan({
      url: seedUrl,
      depth: opts.depth,
      maxPages: opts.maxPages,
      out: opts.out,
      formats,
      ...(opts.auth ? { auth: opts.auth } : {}),
      ...(opts.login ? { login: opts.login } : {}),
      record: opts.record,
      ...(opts.actions ? { actions: opts.actions } : {}),
      rate: opts.rate,
      browser: opts.browser,
      ...(opts.diff ? { diff: opts.diff } : {}),
      respectRobots: opts.respectRobots,
      force: opts.force,
      includeThirdParty: opts.includeThirdParty,
      redact: opts.redact,
      allowLocal: opts.allowLocal,
      telemetry,
      telemetryPreview: opts.telemetryPreview,
      maxBodyBytes: Math.round(opts.maxBodyMb * 1024 * 1024),
      debug: opts.debug,
      ...(opts.debug ? { debugDir: join(opts.out, 'debug') } : {}),
      logger,
      onProgress: (state) => progress.render(state),
    });
    // Hands the terminal back: the table is replaced by the summary rather
    // than left above it.
    progress.stop();

    const { report, files, diff } = result;
    logger.always('');

    if (typeof opts.print === 'string') {
      // A share run must not print a sampled report to stdout either, so the
      // share summary stands in for whatever --print asked for.
      const text = await renderForPrint(opts.share ? 'share' : opts.print, report);
      process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    }

    if (opts.open) {
      const dashboard = files.find((file) => file.endsWith('dashboard.html'));
      if (!dashboard) {
        logger.warn('--open: no dashboard.html was written, so there is nothing to open.');
      } else if (await openFile(dashboard)) {
        logger.success(`Opened ${dashboard} in your browser.`);
      } else {
        logger.info(`Open it yourself: ${dashboard}`);
      }
    }
    logger.success(
      `Scan complete in ${formatDuration(Date.now() - started)} — ` +
        `${report.meta.pagesVisited} page(s) visited, ${report.endpoints.length} endpoint pattern(s) found` +
        (report.webSockets.length > 0
          ? `, ${report.webSockets.length} WebSocket connection(s)`
          : '') +
        '.',
    );
    if (report.technologies.length > 0) {
      logger.always(`  Technologies: ${report.technologies.map((t) => t.name).join(', ')}`);
    }
    if (files.length > 0) {
      logger.always('  Reports written:');
      for (const file of files) logger.always(`   ${chalk.cyan('•')} ${file}`);
    }

    if (isBaseline) {
      const target = explicitBaseline ?? (await resolveBaselinePath());
      await writeBaseline(report, target);
      logger.success(`Baseline stored: ${target}`);
      logger.always(
        explicitBaseline
          ? `  Compare against it later with \`--diff latest --baseline ${explicitBaseline}\`.`
          : '  Compare against it later with `--diff latest`.',
      );
    }

    if (telemetryPlan.print && result.telemetry) {
      logger.always('');
      logger.always('Telemetry preview (not written to disk):');
      logger.always(formatTelemetry(result.telemetry));
    }

    if (diff) {
      logger.always('');
      for (const line of formatDiffSummary(diff)) logger.always(line);
      if (diff.hasChanges && diff.counts.breaking > 0) {
        logger.warn(`${diff.counts.breaking} breaking change(s) — review before shipping.`);
      }
      if (opts.failOnDiff && diff.hasChanges) {
        logger.error('--fail-on-diff: the scan differs from the baseline.');
        process.exitCode = 3;
      }
    }
  } catch (err) {
    const safety = err instanceof SafetyError;
    logger.error(err instanceof Error ? err.message : String(err));
    logger.always(`  ${chalk.cyan('→')} ${hintForError(err)}`);
    if (opts.verbose && err instanceof Error && err.stack) logger.debug(err.stack);
    await writeDebugBundle(logger, opts, debugLog, err);
    process.exitCode = safety ? 2 : 1;
  }
}

/**
 * Write the `--debug` bundle: the captured log lines, plus the browser trace
 * and partial report the scan attached to the error. Best-effort — a failure to
 * write a bundle warns and never becomes a second error on top of the first.
 */
async function writeDebugBundle(
  logger: Logger,
  opts: CliOptions,
  lines: string[] | undefined,
  err: unknown,
): Promise<void> {
  if (!opts.debug) return;
  const dir = join(opts.out, 'debug');
  try {
    await mkdir(dir, { recursive: true });
    const info = debugInfoFor(err);
    const written: string[] = [];
    const logsPath = join(dir, 'logs.txt');
    await writeFile(logsPath, `${(lines ?? []).join('\n')}\n`, 'utf8');
    written.push(logsPath);
    if (info?.trace) written.push(info.trace);
    if (info?.partialReport) written.push(info.partialReport);

    logger.always('');
    logger.always(`Debug bundle written to ${dir}:`);
    for (const file of written) logger.always(`  ${file}`);
  } catch (bundleError) {
    logger.warn(
      `--debug: could not write the diagnostic bundle: ` +
        `${bundleError instanceof Error ? bundleError.message : String(bundleError)}`,
    );
  }
}

/**
 * The report as text for stdout. Rendered through the same reporters that write
 * the files, so what a pipe sees is what the file would have contained.
 */
async function renderForPrint(format: string, report: ReconReport): Promise<string> {
  switch (format) {
    case 'json':
      return JSON.stringify(report, null, 2);
    case 'openapi':
      return renderOpenApi(report);
    case 'share':
      return renderShareSummary(report);
    case 'html':
      return renderHtml(
        renderMarkdown(report),
        `API recon — ${report.meta.seedUrl}`,
        report,
      );
    default:
      return renderMarkdown(report);
  }
}

// Only parse when this module is the program being run, not when a test or the
// completion generator imports it. `realpathSync` is used so the check survives
// the symlink an installed `bin` is invoked through.
const modulePath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1];
const isMain = ((): boolean => {
  if (!invokedPath) return false;
  try {
    return realpathSync(invokedPath) === realpathSync(modulePath);
  } catch {
    return invokedPath === modulePath;
  }
})();
if (isMain) await program.parseAsync(process.argv);

export { program };
