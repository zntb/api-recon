/**
 * Built-artifact guard.
 *
 * Every other test in this repository imports from `src/` through tsx, and
 * `check-pack` only reads the file list npm *would* publish. Neither one ever
 * loads what a consumer actually receives, so a broken `exports` map, a `.d.ts`
 * that stopped being emitted, or a bin that no longer starts would pass every
 * gate and ship. This runs the built package instead: it imports `dist/index.js`,
 * executes the bin, and checks that every emitted module has a declaration.
 *
 *   npm run check:published
 *
 * It must run after `npm run build`, because `dist/` has to exist for any of
 * the assertions to mean anything. The pure helpers are unit-tested without a
 * build (see test/unit/publishedArtifact.test.ts); this script is what proves
 * the real, emitted artifact.
 */

import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Where the build lands, relative to the package root. */
export const DIST_DIR = 'dist';

/**
 * Names the built entry point must expose for the documented API to work.
 *
 * These are the load-bearing ones a consumer reaches for first: the scan
 * handle, the typed error classes the library reference documents, and the
 * format normalizer the CLI and library share. A rename here is a breaking
 * change, and this is where it should be noticed.
 */
export const REQUIRED_EXPORTS: readonly string[] = [
  'scan',
  // All four typed errors the library reference names as exported, so the docs
  // and the entry point cannot drift apart again.
  'SafetyError',
  'RuntimeError',
  'CancelledError',
  'ApiReconError',
  'normalizeFormats',
];

/**
 * Every path an `exports` condition points at, flattened from the map in
 * package.json. Conditions nest (`types`, `import`, `default`), so this walks
 * whatever shape it finds rather than assuming a fixed one.
 */
export function exportTargets(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') {
    into.push(value);
  } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      exportTargets(nested, into);
    }
  }
  return into;
}

/**
 * Targets an `exports` map names that are not present on disk.
 *
 * An `exports` entry pointing at a file the build no longer emits is the
 * quietest packaging break there is: every test still passes, because they all
 * import the source, and the package only fails for whoever installs it.
 */
export function missingExportTargets(root: string, targets: readonly string[]): string[] {
  const missing = new Set<string>();
  for (const target of targets) {
    if (!target.startsWith('./')) continue;
    if (!existsSync(join(root, target))) missing.add(target);
  }
  return [...missing].sort();
}

/**
 * Emitted `.js` files that have no `.d.ts` beside them, relative to `dist/`.
 *
 * TypeScript emits a declaration per module it compiles, so a module without
 * one means the build was reconfigured — which for a TypeScript-first package
 * means consumers lose the types for that import.
 */
export function missingDeclarations(distFiles: readonly string[]): string[] {
  return distFiles
    .filter((file) => file.endsWith('.js') && !distFiles.includes(`${file.slice(0, -3)}.d.ts`))
    .sort();
}

/** The first line of a file, for checking a shebang. */
export function shebangOf(contents: string): string {
  return contents.split('\n', 1)[0] ?? '';
}

/**
 * Run the built bin and report what it printed and how it exited.
 *
 * Spawned through `process.execPath` rather than the path directly, so the
 * check works the same on Windows, where a `.js` bin is not executable on its
 * own, and so a shebang that went missing is caught by the output rather than
 * masked by the platform.
 */
export function runBin(binPath: string, args: readonly string[]): { code: number; output: string } {
  try {
    const output = execFileSync(process.execPath, [binPath, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    return { code: 0, output: `${output}` };
  } catch (err) {
    const failure = err as { status?: number | null; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof failure.status === 'number' ? failure.status : 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}${failure.message ?? ''}`,
    };
  }
}

/** Every `.js` file under `dist/`, as paths relative to `dist/`, slash-separated. */
async function listDist(distRoot: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (entry.isDirectory()) await walk(join(dir, name), `${prefix}${name}/`);
      else found.push(`${prefix}${name}`);
    }
  };
  await walk(distRoot, '');
  return found.sort();
}

async function main(): Promise<void> {
  const root = process.cwd();
  const distRoot = join(root, DIST_DIR);

  if (!existsSync(join(distRoot, 'index.js'))) {
    console.error(`check-published: ${DIST_DIR}/index.js does not exist — run \`npm run build\` first.`);
    process.exit(2);
  }

  const problems: string[] = [];
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    version: string;
    exports?: unknown;
    bin?: Record<string, string>;
  };

  // 1. The `exports` map must point at files the build actually emitted.
  if (pkg.exports) {
    problems.push(
      ...missingExportTargets(root, exportTargets(pkg.exports)).map(
        (target) => `the exports map points at ${target}, which does not exist`,
      ),
    );
  }

  // 2. Every emitted module needs its declaration.
  const distFiles = await listDist(distRoot);
  problems.push(
    ...missingDeclarations(distFiles).map((file) => `${file} has no matching .d.ts`),
  );

  // 3. The entry point must load and expose the documented API.
  const entry = (await import(pathToFileURL(join(distRoot, 'index.js')).href)) as Record<
    string,
    unknown
  >;
  for (const name of REQUIRED_EXPORTS) {
    if (typeof entry[name] !== 'function') {
      problems.push(`dist/index.js does not export a callable \`${name}\``);
    }
  }

  // 4. The bin must still be a script, and must still run.
  const bin = pkg.bin?.['api-recon'];
  if (!bin) {
    problems.push('package.json has no `api-recon` bin');
  } else {
    const binPath = join(root, bin);
    if (!existsSync(binPath)) {
      problems.push(`the bin points at ${bin}, which does not exist`);
    } else {
      if (!shebangOf(await readFile(binPath, 'utf8')).startsWith('#!')) {
        problems.push(`${bin} has no shebang, so it will not start as a command`);
      }
      const version = runBin(binPath, ['--version']);
      if (version.code !== 0) {
        problems.push(`${bin} --version exited ${version.code}: ${version.output.trim()}`);
      } else if (!version.output.includes(pkg.version)) {
        problems.push(
          `${bin} --version printed ${version.output.trim()}, which is not ${pkg.version}`,
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error('\n::error::the built package is not what a consumer would get:\n');
    for (const problem of problems) console.error(`  • ${problem}`);
    console.error(
      '\nThese assertions run against dist/, so a failure here means the build, `exports`,\n' +
        'or `files` in package.json needs attention — not the source.\n',
    );
    process.exit(1);
  }

  console.log(
    `Built package OK — dist/index.js loads and exports ${REQUIRED_EXPORTS.join(', ')}; ` +
      `the bin reports v${pkg.version}; all ${distFiles.length} emitted files have declarations.`,
  );
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) await main();