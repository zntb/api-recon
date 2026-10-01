/**
 * The completion scripts are committed so they can be shipped and reviewed, and
 * generated from the live command definition. This fails when the two drift —
 * a flag added, renamed, or re-described without running
 * `npm run completions:generate`.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { program } from '../../src/cli/index.js';
import {
  COMPLETION_FILENAMES,
  COMPLETION_SHELLS,
  completionScript,
} from '../../src/cli/completion.js';

describe('committed completion scripts', () => {
  for (const shell of COMPLETION_SHELLS) {
    it(`matches the generated ${shell} completion`, async () => {
      const path = join(process.cwd(), 'completions', COMPLETION_FILENAMES[shell]);

      const committed = await readFile(path, 'utf8');

      expect(completionScript(shell, program)).toBe(committed);
    });
  }
});
