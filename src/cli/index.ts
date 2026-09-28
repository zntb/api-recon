#!/usr/bin/env node
/** api-recon CLI. */

import chalk from 'chalk';
import { Command, InvalidArgumentError } from 'commander';
import { BROWSER_ENGINES, formatDiffSummary, normalizeFormats, scan } from '../index.js';
import { resolveEngine } from '../core/browser.js';
import type { BrowserEngine } from '../types.js';
import { showBannerOnce } from '../utils/banner.js';
import { Logger } from '../utils/logger.js';
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
  .option('--max-body-mb <n>', 'maximum response body size to keep, in MB', numberArg, 1)
  .option('-q, --quiet', 'suppress progress output (errors only)', false)
  .option('-v, --verbose', 'verbose progress output', false)
  .action(async (seedUrl: string, opts: CliOptions) => {
    const logger = new Logger({ quiet: opts.quiet, verbose: opts.verbose });
    showBannerOnce(logger);

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
      const started = Date.now();
      logger.info(`Scanning ${chalk.bold(seedUrl)} (depth ${opts.depth}, max ${opts.maxPages} pages)`);

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
        maxBodyBytes: Math.round(opts.maxBodyMb * 1024 * 1024),
        logger,
      });

      const { report, files, diff } = result;
      logger.always('');
      logger.success(
        `Scan complete in ${formatDuration(Date.now() - started)} — ` +
          `${report.meta.pagesVisited} page(s) visited, ${report.endpoints.length} endpoint pattern(s) found.`,
      );
      if (report.technologies.length > 0) {
        logger.always(`  Technologies: ${report.technologies.map((t) => t.name).join(', ')}`);
      }
      if (files.length > 0) {
        logger.always('  Reports written:');
        for (const file of files) logger.always(`   ${chalk.cyan('•')} ${file}`);
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
  maxBodyMb: number;
  quiet: boolean;
  verbose: boolean;
}

await program.parseAsync(process.argv);
