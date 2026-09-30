#!/usr/bin/env node
/** api-recon CLI. */

import chalk from 'chalk';
import { Command, InvalidArgumentError } from 'commander';
import { BROWSER_ENGINES, formatDiffSummary, normalizeFormats, scan } from '../index.js';
import { resolveEngine } from '../core/browser.js';
import { CONFIG_FILENAMES } from './config.js';
import { formatTelemetry, resolveTelemetryPlan } from '../core/telemetry.js';
import type { BrowserEngine } from '../types.js';
import { showBannerOnce } from '../utils/banner.js';
import { Logger } from '../utils/logger.js';
import { LiveProgress, progressModeFor } from '../utils/progress.js';
import { resolveOptions } from './config.js';
import { SafetyError } from '../utils/safety.js';
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

const program = new Command();

program
  .name('api-recon')
  .description(
    'Discover a website\'s APIs by driving a headless browser, simulating user actions, and exporting a categorized report (JSON, Markdown, HTML, PDF, OpenAPI, interactive dashboard).',
  )
  .version(TOOL_VERSION)
  .argument('<seedUrl>', 'URL to start from, e.g. https://example.com')
  .option('-d, --depth <n>', 'same-domain crawl depth (0 = seed page only)', intArg, 1)
  .option('-m, --max-pages <n>', 'hard cap on pages visited', intArg, 25)
  .option(
    '--config <file>',
    `path to a project config file (default: the nearest ${CONFIG_FILENAMES.join(' / ')} up from the working directory)`,
  )
  .option('--no-config', 'ignore any project config file, even one found on the way up')
  .option('-o, --out <dir>', 'output directory for reports', './api-recon-output')
  .option(
    '-f, --formats <list>',
    'comma-separated report formats (json,md,html,pdf,openapi,dashboard)',
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
  .option('--diff <file>', 'compare this scan against a previous report.json and report API changes')
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
  .action(async (seedUrl: string, raw: CliOptions) => {
    // Fold the command line, the environment, and any project config file into
    // one set of options before anything acts on them — so a guard like
    // --fail-on-diff is satisfied by a config file too, as its precedence
    // implies, and --quiet can come from the file.
    let opts = raw;
    let resolved: Awaited<ReturnType<typeof resolveOptions>>;
    try {
      resolved = await resolveOptions({
        cli: raw as unknown as Record<string, unknown>,
        isExplicit: (key) => program.getOptionValueSource(key) === 'cli',
      });
      opts = resolved.options as unknown as CliOptions;
    } catch (err) {
      const logger = new Logger({ quiet: raw.quiet, verbose: raw.verbose });
      logger.error(err instanceof SafetyError ? err.message : String(err));
      process.exitCode = 2;
      return;
    }

    const logger = new Logger({ quiet: opts.quiet, verbose: opts.verbose });
    showBannerOnce(logger);
    if (resolved.configPath) {
      logger.debug(`config: ${resolved.configPath}`);
      const fromConfig = Object.entries(resolved.provenance)
        .filter(([, source]) => source === 'config')
        .map(([key]) => key);
      if (fromConfig.length > 0) logger.debug(`  settings from config: ${fromConfig.join(', ')}`);
    } else if (resolved.configIgnored) {
      logger.debug('config: ignored (--no-config)');
    }

    if (!opts.respectRobots && !opts.force) {
      logger.error(
        '--no-respect-robots requires --force, which acknowledges that you own or may test the target.',
      );
      process.exitCode = 2;
      return;
    }

    if (opts.failOnDiff && !opts.diff) {
      logger.error('--fail-on-diff only means something together with --diff <file>.');
      process.exitCode = 2;
      return;
    }

    try {
      const formats = normalizeFormats(opts.formats.split(','));
      // Off unless asked for on the command line or in the environment.
      const telemetry = opts.telemetry || process.env.API_RECON_TELEMETRY === '1';
      const telemetryPlan = resolveTelemetryPlan({
        telemetry,
        telemetryPreview: opts.telemetryPreview,
      });
      const started = Date.now();
      // A terminal gets the running table; a pipe gets JSON only when asked for
      // it, and otherwise nothing — redrawn ANSI frames in a log file are noise.
      const progress = new LiveProgress({
        mode: progressModeFor({ json: opts.jsonProgress, quiet: opts.quiet }),
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
        logger,
        onProgress: (state) => progress.render(state),
      });
      // Hands the terminal back: the table is replaced by the summary rather
      // than left above it.
      progress.stop();

      const { report, files, diff } = result;
      logger.always('');
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
      if (err instanceof SafetyError) {
        logger.error(err.message);
        process.exitCode = 2;
      } else {
        logger.error(err instanceof Error ? err.message : String(err));
        if (opts.verbose && err instanceof Error && err.stack) logger.debug(err.stack);
        process.exitCode = 1;
      }
    }
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
  /** A path from --config, `false` from --no-config, absent when discovering. */
  config?: string | boolean;
}

await program.parseAsync(process.argv);
