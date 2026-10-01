/**
 * Regenerate the committed shell completion scripts under `completions/`.
 *
 * The scripts are checked in so a package consumer (or a Homebrew formula) has
 * them without running the CLI, and `test/unit/completionFreshness.test.ts`
 * fails when a flag is added or renamed without regenerating them.
 *
 *   npm run completions:generate
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { program } from '../src/cli/index.js';
import {
  COMPLETION_FILENAMES,
  COMPLETION_SHELLS,
  completionScript,
} from '../src/cli/completion.js';

const OUT_DIR = 'completions';

await mkdir(OUT_DIR, { recursive: true });
for (const shell of COMPLETION_SHELLS) {
  const file = join(OUT_DIR, COMPLETION_FILENAMES[shell]);
  await writeFile(file, completionScript(shell, program), 'utf8');
  console.log(`Wrote ${file}`);
}
