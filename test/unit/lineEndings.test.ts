import { describe, expect, it } from 'vitest';
import { parseEolListing } from '../../scripts/check-line-endings.js';

/**
 * Build one `git ls-files --eol` line using Git's real layout: the columns are
 * space-padded and a single tab separates them from the path, e.g.
 *
 *   i/lf    w/lf    attr/text=auto eol=lf <TAB> .gitignore
 */
function line(indexEol: string, workTreeEol: string, attributes: string, path: string): string {
  return `i/${indexEol}    w/${workTreeEol}    ${attributes}\t${path}`;
}

describe('parseEolListing', () => {
  it('accepts LF files and reports nothing', () => {
    const output = [
      line('lf', 'lf', 'attr/text eol=lf', '.github/workflows/ci.yml'),
      line('lf', 'lf', 'attr/text=auto eol=lf', '.gitignore'),
      line('lf', 'lf', 'attr/text=auto eol=lf', 'README.md'),
    ].join('\n');

    expect(parseEolListing(output)).toEqual([]);
  });

  it('flags a file whose working tree is CRLF', () => {
    const output = line('lf', 'crlf', 'attr/text=auto eol=lf', 'src/index.ts');

    const offenders = parseEolListing(output);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toMatchObject({
      path: 'src/index.ts',
      indexEol: 'lf',
      workTreeEol: 'crlf',
    });
  });

  it('flags a file whose stored blob is CRLF even if the working tree looks fine', () => {
    const offenders = parseEolListing(line('crlf', 'crlf', 'attr/text', 'legacy.js'));

    expect(offenders).toHaveLength(1);
    expect(offenders[0]!.indexEol).toBe('crlf');
  });

  it('flags a mixed line-ending file', () => {
    const offenders = parseEolListing(line('lf', 'mixed', 'attr/text=auto eol=lf', 'notes.md'));

    expect(offenders).toHaveLength(1);
    expect(offenders[0]!.workTreeEol).toBe('mixed');
  });

  it('respects files .gitattributes marks as CRLF', () => {
    const output = line('lf', 'crlf', 'attr/text eol=crlf', 'scripts/build.bat');

    expect(parseEolListing(output)).toEqual([]);
  });

  it('respects binary files', () => {
    const output = [
      line('-text', '-text', 'attr/-text', 'assets/logo.png'),
      line('-text', '-text', 'attr/binary', 'examples/output/report.pdf'),
    ].join('\n');

    expect(parseEolListing(output)).toEqual([]);
  });

  it('ignores blank lines and lines without a path column', () => {
    const offenders = parseEolListing(
      ['', '   ', 'i/lf w/lf attr/text eol=lf'].join('\n'),
    );

    expect(offenders).toEqual([]);
  });

  it('reports every offender, not just the first', () => {
    const output = [
      line('lf', 'crlf', 'attr/text=auto eol=lf', 'a.ts'),
      line('lf', 'lf', 'attr/text=auto eol=lf', 'b.ts'),
      line('crlf', 'crlf', 'attr/text', 'c.ts'),
    ].join('\n');

    expect(parseEolListing(output).map((o) => o.path)).toEqual(['a.ts', 'c.ts']);
  });
});
