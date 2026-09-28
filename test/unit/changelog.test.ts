import { describe, expect, it } from 'vitest';
import { extractChangelogSection } from '../../scripts/changelog.js';

const CHANGELOG = `# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Something not shipped yet.

## [0.2.0] - 2026-10-01

Second release. Tightened the analyzer heuristics.

### Added

- A new flag.

### Fixed

- An off-by-one in query parameter samples.

## [0.1.0] - 2026-09-27

First release.

### Added

- Everything.

[Unreleased]: https://github.com/zntb/api-recon/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/zntb/api-recon/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/zntb/api-recon/releases/tag/v0.1.0
`;

describe('extractChangelogSection', () => {
  it('extracts the body for a version, without its heading', () => {
    const section = extractChangelogSection(CHANGELOG, '0.2.0');

    expect(section).not.toBeNull();
    expect(section!.heading).toBe('## [0.2.0] - 2026-10-01');
    expect(section!.body).toContain('Second release.');
    expect(section!.body).toContain('### Fixed');
    expect(section!.body).toContain('An off-by-one');
    // The heading itself and the next version's content are excluded.
    expect(section!.body).not.toContain('## [0.2.0]');
    expect(section!.body).not.toContain('First release.');
  });

  it('stops before the link-reference block at the foot of the file', () => {
    const section = extractChangelogSection(CHANGELOG, '0.1.0');

    expect(section!.body).toContain('First release.');
    expect(section!.body).not.toContain('[0.1.0]: https://github.com');
    expect(section!.body).not.toContain('compare/v0.1.0');
  });

  it('returns null when the version has no section', () => {
    expect(extractChangelogSection(CHANGELOG, '9.9.9')).toBeNull();
  });

  it('does not match a longer version that merely starts with the same digits', () => {
    // `0.1.0` must not match the `0.10.0` heading.
    const changelog = '# Changelog\n\n## [0.10.0] - 2026-11-01\n\nTen.\n';

    expect(extractChangelogSection(changelog, '0.1.0')).toBeNull();
    expect(extractChangelogSection(changelog, '0.10.0')?.body).toBe('Ten.');
  });

  it('accepts the common heading variants', () => {
    const variants = ['## [0.2.0]', '## 0.2.0', '## v0.2.0', '## [v0.2.0] - 2026-10-01'];

    for (const heading of variants) {
      const section = extractChangelogSection(`# Changelog\n\n${heading}\n\nBody text.\n`, '0.2.0');
      expect(section?.body, heading).toBe('Body text.');
    }
  });

  it('handles CRLF input', () => {
    const crlf = '# Changelog\r\n\r\n## [0.2.0] - 2026-10-01\r\n\r\nBody text.\r\n';

    expect(extractChangelogSection(crlf, '0.2.0')?.body).toBe('Body text.');
  });

  it('reports an empty section as an empty body', () => {
    const section = extractChangelogSection('# Changelog\n\n## [0.3.0] - 2026-12-01\n', '0.3.0');

    expect(section).not.toBeNull();
    expect(section!.body).toBe('');
  });
});
