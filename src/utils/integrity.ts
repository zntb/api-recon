/**
 * Report integrity — an optional checksum (and HMAC) manifest for shared
 * reports.
 *
 * A report that leaves the machine it was written on can be edited on the way.
 * `--checksum` writes a `checksums.json` beside the reports that records a
 * digest of every file, so a recipient can recompute each digest and confirm
 * the bytes are the ones the scan wrote. That is an integrity check, not
 * proof of origin: anyone can edit a file *and* the manifest that covers it.
 *
 * For origin, `--sign-key <file>` adds an HMAC over the manifest itself. A
 * recipient with the same key can confirm both that the files match and that
 * the manifest was produced by someone holding the key, so a tampered manifest
 * cannot be recomputed by an attacker.
 *
 * The same role the npm provenance attestation plays for the published tarball
 * — linking an artifact to the run that produced it — is played here by the
 * tool name and version recorded in the manifest, signed alongside the files.
 *
 * The module is pure except for the small file helpers at the bottom: the
 * digest, signature, and verification functions take and return values, so the
 * manifest can be checked in a test or by an embedding application.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { TOOL_NAME, TOOL_VERSION } from '../version.js';
import { SafetyError } from './errors.js';

/** Digest algorithms a manifest may name. */
export const INTEGRITY_ALGORITHMS = ['sha256', 'sha512'] as const;
export type IntegrityAlgorithm = (typeof INTEGRITY_ALGORITHMS)[number];

/** The manifest filename written beside the reports. */
export const INTEGRITY_FILENAME = 'checksums.json';

/** Bumped when the manifest's shape changes, so a reader can reject a shape it cannot read. */
export const INTEGRITY_MANIFEST_VERSION = 1;

/** The HMAC scheme recorded on a signed manifest, matching the digest algorithm. */
export function hmacScheme(algorithm: IntegrityAlgorithm): `hmac-${IntegrityAlgorithm}` {
  return `hmac-${algorithm}`;
}

export interface IntegrityFileEntry {
  file: string;
  digest: string;
}

export interface IntegritySignature {
  /** `hmac-sha256` or `hmac-sha512`. */
  scheme: string;
  /** Lowercase hex HMAC over the manifest's canonical payload. */
  value: string;
}

/**
 * A sidecar over the written reports. `files` maps each artifact's filename (as
 * written into the output directory) to its digest, so a recipient can check
 * the file they received without knowing the tool's internals.
 */
export interface IntegrityManifest {
  version: number;
  algorithm: IntegrityAlgorithm;
  generatedAt: string;
  tool: { name: string; version: string };
  files: Record<string, string>;
  /** Present only when the manifest was signed with an HMAC key. */
  signature?: IntegritySignature;
}

/** True when `value` names a digest algorithm this tool can compute. */
export function isIntegrityAlgorithm(value: unknown): value is IntegrityAlgorithm {
  return typeof value === 'string' && (INTEGRITY_ALGORITHMS as readonly string[]).includes(value);
}

/**
 * Resolve a user-supplied `--checksum` value into an algorithm, or `null` when
 * the feature is off. A bare flag (or `true`) means the default, `sha256`; a
 * name is validated here so a typo fails before any work starts.
 */
export function resolveIntegrityAlgorithm(value: unknown): IntegrityAlgorithm | null {
  if (value === undefined || value === null || value === false) return null;
  if (value === true) return 'sha256';
  if (typeof value === 'string') {
    const name = value.trim().toLowerCase();
    if (isIntegrityAlgorithm(name)) return name;
  }
  throw new SafetyError(
    `Unknown checksum algorithm ${JSON.stringify(value)}. Valid algorithms: ${INTEGRITY_ALGORITHMS.join(', ')}.`,
    { hint: 'Pass --checksum with no value for sha256, or --checksum sha512.' },
  );
}

/** Lowercase hex digest of a byte payload or string. */
export function digestOf(data: string | Uint8Array, algorithm: IntegrityAlgorithm): string {
  return createHash(algorithm).update(data).digest('hex');
}

/** Lowercase hex HMAC of a byte payload or string. */
export function hmacOf(
  data: string | Uint8Array,
  key: string | Uint8Array,
  algorithm: IntegrityAlgorithm,
): string {
  return createHmac(algorithm, key).update(data).digest('hex');
}

/**
 * The canonical bytes the signature covers: the manifest's own fields plus one
 * line per file, sorted by name. Fixing the order makes the signature
 * independent of how the JSON object happened to be built, and covering
 * `algorithm` and `tool` keeps a manifest from being re-labelled without
 * invalidating its signature.
 */
export function signaturePayload(manifest: IntegrityManifest): string {
  const files = Object.keys(manifest.files)
    .sort()
    .map((name) => `file:${name}:${manifest.files[name]}`);
  return [
    `version:${manifest.version}`,
    `algorithm:${manifest.algorithm}`,
    `generatedAt:${manifest.generatedAt}`,
    `tool:${manifest.tool.name}@${manifest.tool.version}`,
    ...files,
  ].join('\n');
}

export interface BuildIntegrityInput {
  /** Filename (relative to the output directory) to its bytes or text. */
  files: Record<string, string | Uint8Array>;
  algorithm?: IntegrityAlgorithm;
  /** When set, the manifest is signed with this key. */
  key?: string | Uint8Array;
  generatedAt?: string;
  toolName?: string;
  toolVersion?: string;
  version?: number;
}

/**
 * Build the manifest: a digest per file, and — when a key is given — an HMAC
 * over the manifest's canonical payload. File keys are sorted so the JSON is
 * deterministic and diffable.
 */
export function buildIntegrityManifest(input: BuildIntegrityInput): IntegrityManifest {
  const algorithm = input.algorithm ?? 'sha256';
  const files: Record<string, string> = {};
  for (const name of Object.keys(input.files).sort()) {
    files[name] = digestOf(input.files[name]!, algorithm);
  }

  const manifest: IntegrityManifest = {
    version: input.version ?? INTEGRITY_MANIFEST_VERSION,
    algorithm,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    tool: {
      name: input.toolName ?? TOOL_NAME,
      version: input.toolVersion ?? TOOL_VERSION,
    },
    files,
  };

  if (input.key !== undefined && input.key.length > 0) {
    manifest.signature = {
      scheme: hmacScheme(algorithm),
      value: hmacOf(signaturePayload(manifest), input.key, algorithm),
    };
  }
  return manifest;
}

export interface IntegrityVerification {
  valid: boolean;
  /** One line per problem; empty when the report verifies. */
  errors: string[];
  /** How many files the manifest covers. */
  checked: number;
  /** True when the manifest carried a signature (whether or not it was checked). */
  signed: boolean;
}

/** Constant-time comparison of two lowercase hex strings, tolerant of length. */
function hexEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/**
 * Check a manifest against the files it covers. Every problem is collected
 * rather than short-circuited, so a recipient sees all of them at once. A
 * signed manifest with no key supplied is reported — silently skipping the
 * signature would turn an authenticity check into a checksum one.
 */
export function verifyIntegrityManifest(
  manifest: IntegrityManifest,
  files: Record<string, string | Uint8Array>,
  key?: string | Uint8Array,
): IntegrityVerification {
  const errors: string[] = [];

  if (manifest.signature) {
    if (key === undefined || key.length === 0) {
      errors.push(
        `the manifest is signed (${manifest.signature.scheme}) but no key was supplied — pass --sign-key`,
      );
    } else {
      const expected = hmacOf(signaturePayload(manifest), key, manifest.algorithm);
      if (!hexEqual(expected, manifest.signature.value)) {
        errors.push(
          'the manifest signature does not match — it was edited, or signed with a different key',
        );
      }
    }
  }

  for (const name of Object.keys(manifest.files).sort()) {
    const expected = manifest.files[name]!;
    const data = files[name];
    if (data === undefined) {
      errors.push(`${name}: file is missing`);
      continue;
    }
    const actual = digestOf(data, manifest.algorithm);
    if (!hexEqual(actual, expected)) {
      errors.push(`${name}: checksum mismatch — the file was edited`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    checked: Object.keys(manifest.files).length,
    signed: manifest.signature !== undefined,
  };
}

/** Read and validate a manifest document, refusing a shape this build cannot check. */
export function parseIntegrityManifest(value: unknown): IntegrityManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SafetyError('The integrity manifest must be a JSON object.', {
      hint: 'Pass the checksums.json written by --checksum.',
    });
  }
  const raw = value as Record<string, unknown>;

  const algorithm = raw['algorithm'];
  if (!isIntegrityAlgorithm(algorithm)) {
    throw new SafetyError(
      `The integrity manifest names an unsupported algorithm ${JSON.stringify(algorithm)}. ` +
        `Valid algorithms: ${INTEGRITY_ALGORITHMS.join(', ')}.`,
      { hint: 'Regenerate it with a build that wrote this shape, or check it by hand.' },
    );
  }

  const rawFiles = raw['files'];
  if (rawFiles === null || typeof rawFiles !== 'object' || Array.isArray(rawFiles)) {
    throw new SafetyError('The integrity manifest has no "files" map to check.');
  }
  const files: Record<string, string> = {};
  for (const [name, digest] of Object.entries(rawFiles as Record<string, unknown>)) {
    if (typeof digest !== 'string' || digest === '') {
      throw new SafetyError(`The integrity manifest entry for "${name}" is not a digest string.`);
    }
    // A manifest is untrusted input: a recipient runs this on a `checksums.json`
    // that arrived with the artifact, from whoever sent it. Every name written
    // by `buildIntegrityManifest` is relative to the output directory, so a
    // name that is absolute — or that climbs out with `..` — is never
    // legitimate, and accepting one would let a manifest steer a read of any
    // file the process can reach. Checked here, at the single point every
    // caller parses through, rather than at each place a name is resolved.
    if (isAbsolute(name) || normalize(name).split(/[\\/]/).includes('..')) {
      throw new SafetyError(
        `The integrity manifest names "${name}", which is outside the report directory.`,
        { hint: 'A manifest can only name files that sit beside it.' },
      );
    }
    files[name] = digest;
  }

  const toolRaw = raw['tool'];
  const tool = {
    name:
      toolRaw && typeof toolRaw === 'object' && !Array.isArray(toolRaw)
        ? String((toolRaw as Record<string, unknown>)['name'] ?? 'unknown')
        : 'unknown',
    version:
      toolRaw && typeof toolRaw === 'object' && !Array.isArray(toolRaw)
        ? String((toolRaw as Record<string, unknown>)['version'] ?? 'unknown')
        : 'unknown',
  };

  const manifest: IntegrityManifest = {
    version: typeof raw['version'] === 'number' ? raw['version'] : INTEGRITY_MANIFEST_VERSION,
    algorithm,
    generatedAt: typeof raw['generatedAt'] === 'string' ? raw['generatedAt'] : '',
    tool,
    files,
  };

  const signature = raw['signature'];
  if (signature !== undefined) {
    if (
      signature === null ||
      typeof signature !== 'object' ||
      Array.isArray(signature) ||
      typeof (signature as Record<string, unknown>)['value'] !== 'string'
    ) {
      throw new SafetyError('The integrity manifest\'s signature is malformed.');
    }
    manifest.signature = {
      scheme: String((signature as Record<string, unknown>)['scheme'] ?? hmacScheme(algorithm)),
      value: (signature as Record<string, unknown>)['value'] as string,
    };
  }

  return manifest;
}

// ---- file helpers ----------------------------------------------------------

export interface WriteIntegrityOptions {
  algorithm: IntegrityAlgorithm;
  /** When set, the manifest is signed with this key. */
  key?: string;
  generatedAt?: string;
}

/**
 * Read every written report, build the manifest, and write it into the output
 * directory. Hashing the bytes on disk (rather than the strings that produced
 * them) is what makes the digest describe the artifact a recipient receives.
 * The manifest never covers itself.
 */
export async function writeIntegrityManifest(
  files: readonly string[],
  outDir: string,
  options: WriteIntegrityOptions,
): Promise<string> {
  const payloads: Record<string, Uint8Array> = {};
  for (const file of files) {
    // Kept relative to the output directory (and slash-separated) so a spilled
    // payload under `payloads/` is named the same way the report names it —
    // `basename` would flatten it into the output root and break verification.
    const name = relative(resolve(outDir), resolve(file)).split(/[\\/]/).join('/');
    if (name === INTEGRITY_FILENAME) continue;
    payloads[name] = await readFile(file);
  }

  const manifest = buildIntegrityManifest({
    files: payloads,
    algorithm: options.algorithm,
    ...(options.key ? { key: options.key } : {}),
    ...(options.generatedAt ? { generatedAt: options.generatedAt } : {}),
  });

  await mkdir(outDir, { recursive: true });
  const target = join(outDir, INTEGRITY_FILENAME);
  await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return target;
}

/** Read an HMAC key from a file, refusing an empty one rather than signing with nothing. */
export async function readSignKeyFile(path: string): Promise<string> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new SafetyError(`HMAC key file not found: ${path}`, {
      hint: 'Point --sign-key at a file holding the key, or drop --sign-key to write an unsigned manifest.',
    });
  }
  const key = text.trim();
  if (key === '') {
    throw new SafetyError(`HMAC key file is empty: ${path}`, {
      hint: 'Write the key to the file, or drop --sign-key to write an unsigned manifest.',
    });
  }
  return key;
}

export interface IntegrityCheckResult {
  /** The directory the manifest and reports live in. */
  dir: string;
  manifest: IntegrityManifest;
  verification: IntegrityVerification;
}

/**
 * Load a manifest and the files it names (relative to the manifest's own
 * directory), then check them. A missing referenced file is a verification
 * failure, not a load error, so the result lists it like any other problem.
 */
export async function verifyManifestFromDisk(
  manifestPath: string,
  keyPath?: string,
): Promise<IntegrityCheckResult> {
  const absolute = resolve(manifestPath);
  let text: string;
  try {
    text = await readFile(absolute, 'utf8');
  } catch {
    throw new SafetyError(`Integrity manifest not found: ${absolute}`, {
      hint: 'Pass the path to the checksums.json written beside the reports.',
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new SafetyError(
      `Integrity manifest ${absolute} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      { hint: 'Pass the checksums.json file itself, not a report.' },
    );
  }

  const manifest = parseIntegrityManifest(parsed);
  const dir = dirname(absolute);

  const files: Record<string, Uint8Array> = {};
  for (const name of Object.keys(manifest.files)) {
    try {
      files[name] = await readFile(join(dir, name));
    } catch {
      // Left absent on purpose: verification reports it as "file is missing".
    }
  }

  const key = keyPath ? await readSignKeyFile(keyPath) : undefined;
  return { dir, manifest, verification: verifyIntegrityManifest(manifest, files, key) };
}
