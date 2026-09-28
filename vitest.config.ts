import { dirname, resolve as resolvePath } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * The package emits NodeNext-style ESM, so relative imports use explicit `.js`
 * specifiers that TypeScript maps back to the `.ts` sources. tsx and tsc do
 * this automatically; this plugin teaches Vite's resolver the same trick.
 *
 * Vitest hands importers ids with query suffixes (`?vitest=...`) and may run
 * with a non-file importer, so both sides are normalized to plain paths.
 */
function jsToTsResolver(): Plugin {
  return {
    name: 'api-recon:resolve-js-to-ts',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!source.startsWith('./') && !source.startsWith('../')) return null;
      if (!source.endsWith('.js')) return null;

      let importerPath = importer ?? '';
      if (importerPath.startsWith('file://')) importerPath = fileURLToPath(importerPath);
      importerPath = importerPath.split('?')[0]!.split('#')[0]!;
      if (!importerPath || !importerPath.startsWith('/')) return null;

      const candidate = resolvePath(dirname(importerPath), source.slice(0, -'.js'.length) + '.ts');
      return existsSync(candidate) ? candidate : null;
    },
  };
}

export default defineConfig({
  plugins: [jsToTsResolver()],
  test: {
    include: ['test/**/*.test.ts'],
    // Browser-driven integration tests are heavy; run files one at a time.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
