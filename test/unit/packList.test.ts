import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TOP_LEVEL,
  REQUIRED_ENTRIES,
  packViolations,
} from '../../scripts/check-pack.js';

/** Every required entry, plus one file from each allowed root. */
function goodList(): string[] {
  return [
    ...REQUIRED_ENTRIES,
    'dist/cli/index.js.map',
    'completions/api-recon.bash',
    'docs/reference/cli.md',
    'dist/reporters/json.js',
  ];
}

describe('packViolations', () => {
  it('accepts a tarball built from the expected roots', () => {
    expect(packViolations(goodList())).toEqual([]);
  });

  it('accepts every path under an allowed root', () => {
    expect(ALLOWED_TOP_LEVEL).not.toContain('src');
    expect(packViolations([...goodList(), 'dist/core/crawler.js'])).toEqual([]);
  });

  it('rejects a file outside the published set', () => {
    const problems = packViolations([...goodList(), 'src/index.ts']);
    expect(problems).toEqual(['unexpected entry in the tarball: src/index.ts']);
  });

  it('rejects a stray file at the package root', () => {
    const problems = packViolations([...goodList(), '.api-reconrc']);
    expect(problems).toEqual(['unexpected entry in the tarball: .api-reconrc']);
  });

  it('reports each missing required file', () => {
    const problems = packViolations(['package.json']);
    expect(problems).toContain('missing from the tarball: dist/index.js');
    expect(problems).toContain('missing from the tarball: schema/report.schema.json');
    expect(problems).not.toContain('missing from the tarball: package.json');
  });

  it('reports extras and misses together', () => {
    const problems = packViolations(['dist/index.js', 'examples/output/report.json']);
    expect(problems).toContain('unexpected entry in the tarball: examples/output/report.json');
    expect(problems).toContain('missing from the tarball: README.md');
  });
});
