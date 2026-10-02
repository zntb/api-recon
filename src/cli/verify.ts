/**
 * `api-recon verify <manifest>` — check reports against a `checksums.json`.
 *
 * The counterpart to `--checksum`: a recipient who did not run the scan (or who
 * received the reports from someone else) points this at the manifest and gets
 * a yes/no, plus every file that failed. It reads only the manifest and the
 * files the manifest names, so it launches no browser and performs no network
 * work.
 *
 * Exit codes match the scan's: `0` when everything verifies, `2` when the
 * manifest cannot be read or a file does not match, so a pipeline can fail on
 * it the way a safety guard fails.
 */

import chalk from 'chalk';
import type { Logger } from '../utils/logger.js';
import { hintForError, SafetyError } from '../utils/errors.js';
import { verifyManifestFromDisk } from '../utils/integrity.js';

export async function runVerify(
  manifestPath: string,
  signKeyPath: string | undefined,
  logger: Logger,
): Promise<number> {
  let result: Awaited<ReturnType<typeof verifyManifestFromDisk>>;
  try {
    result = await verifyManifestFromDisk(manifestPath, signKeyPath);
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    logger.always(`  ${chalk.cyan('→')} ${hintForError(err)}`);
    return err instanceof SafetyError ? 2 : 1;
  }

  const { dir, manifest, verification } = result;
  if (verification.valid) {
    logger.success(
      `Integrity OK — ${verification.checked} file(s) match the ${manifest.algorithm} manifest` +
        (verification.signed ? ', and the HMAC signature is valid' : '') +
        '.',
    );
    if (dir) logger.always(`  ${dir}`);
    return 0;
  }

  logger.error(`Integrity check failed for ${manifestPath}:`);
  for (const problem of verification.errors) {
    logger.always(`   ${chalk.red('•')} ${problem}`);
  }
  logger.always(
    `  ${chalk.cyan('→')} If the reports are not the ones the scan wrote, re-run the scan.`,
  );
  return 2;
}
