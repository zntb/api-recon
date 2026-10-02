import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INTEGRITY_FILENAME,
  buildIntegrityManifest,
  digestOf,
  hmacOf,
  isIntegrityAlgorithm,
  parseIntegrityManifest,
  readSignKeyFile,
  resolveIntegrityAlgorithm,
  signaturePayload,
  verifyIntegrityManifest,
  verifyManifestFromDisk,
  writeIntegrityManifest,
} from '../../src/utils/integrity.js';
import { SafetyError } from '../../src/utils/errors.js';

const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('digestOf', () => {
  it('matches known vectors for text and bytes', () => {
    expect(digestOf('abc', 'sha256')).toBe(SHA256_ABC);
    expect(digestOf('', 'sha256')).toBe(SHA256_EMPTY);
    expect(digestOf(new Uint8Array([0x61, 0x62, 0x63]), 'sha256')).toBe(SHA256_ABC);
  });

  it('produces a different, shorter-or-longer digest per algorithm', () => {
    expect(digestOf('abc', 'sha512')).toHaveLength(128);
    expect(digestOf('abc', 'sha256')).toHaveLength(64);
  });
});

describe('hmacOf', () => {
  it('matches RFC 4231 test case 1', () => {
    const key = Buffer.alloc(20, 0x0b);
    expect(hmacOf('Hi There', key, 'sha256')).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    );
  });

  it('depends on the key', () => {
    expect(hmacOf('message', 'key-one', 'sha256')).not.toBe(hmacOf('message', 'key-two', 'sha256'));
  });
});

describe('isIntegrityAlgorithm / resolveIntegrityAlgorithm', () => {
  it('accepts the two supported algorithms', () => {
    expect(isIntegrityAlgorithm('sha256')).toBe(true);
    expect(isIntegrityAlgorithm('sha512')).toBe(true);
    expect(isIntegrityAlgorithm('md5')).toBe(false);
    expect(isIntegrityAlgorithm(true)).toBe(false);
  });

  it('treats absence and false as off, and true as the default', () => {
    expect(resolveIntegrityAlgorithm(undefined)).toBeNull();
    expect(resolveIntegrityAlgorithm(false)).toBeNull();
    expect(resolveIntegrityAlgorithm(true)).toBe('sha256');
    expect(resolveIntegrityAlgorithm('SHA512')).toBe('sha512');
  });

  it('names the valid algorithms when the value is unknown', () => {
    expect(() => resolveIntegrityAlgorithm('md5')).toThrow(SafetyError);
    expect(() => resolveIntegrityAlgorithm('md5')).toThrow(/Valid algorithms: sha256, sha512/);
  });
});

describe('buildIntegrityManifest', () => {
  it('records a sorted digest per file', () => {
    const manifest = buildIntegrityManifest({
      files: { 'b.md': 'second', 'a.json': 'first' },
      generatedAt: '2026-10-02T00:00:00.000Z',
      toolVersion: '9.9.9',
    });

    expect(Object.keys(manifest.files)).toEqual(['a.json', 'b.md']);
    expect(manifest.files['a.json']).toBe(digestOf('first', 'sha256'));
    expect(manifest.generatedAt).toBe('2026-10-02T00:00:00.000Z');
    expect(manifest.algorithm).toBe('sha256');
    expect(manifest.version).toBe(1);
    expect(manifest.signature).toBeUndefined();
  });

  it('signs the canonical payload when a key is given', () => {
    const manifest = buildIntegrityManifest({ files: { 'report.json': '{}' }, key: 'secret' });
    expect(manifest.signature?.scheme).toBe('hmac-sha256');

    const expected = hmacOf(signaturePayload(manifest), 'secret', 'sha256');
    expect(manifest.signature?.value).toBe(expected);
    // The signature is over the payload, so it covers the algorithm and tool.
    expect(signaturePayload(manifest)).toContain('algorithm:sha256');
    expect(signaturePayload(manifest)).toContain('file:report.json:');
  });

  it('does not sign when the key is empty', () => {
    expect(buildIntegrityManifest({ files: {}, key: '' }).signature).toBeUndefined();
  });
});

describe('verifyIntegrityManifest', () => {
  const manifest = buildIntegrityManifest({ files: { 'report.json': '{"a":1}' } });

  it('passes when the files match', () => {
    const result = verifyIntegrityManifest(manifest, { 'report.json': '{"a":1}' });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.checked).toBe(1);
    expect(result.signed).toBe(false);
  });

  it('reports an edited file and a missing one', () => {
    const edited = verifyIntegrityManifest(manifest, { 'report.json': '{"a":2}' });
    expect(edited.valid).toBe(false);
    expect(edited.errors[0]).toMatch(/report\.json: checksum mismatch/);

    const missing = verifyIntegrityManifest(manifest, {});
    expect(missing.valid).toBe(false);
    expect(missing.errors[0]).toMatch(/report\.json: file is missing/);
  });

  it('accepts a signature with the right key and rejects the wrong one', () => {
    const signed = buildIntegrityManifest({ files: { 'report.json': '{}' }, key: 'correct' });

    expect(verifyIntegrityManifest(signed, { 'report.json': '{}' }, 'correct').valid).toBe(true);

    const wrong = verifyIntegrityManifest(signed, { 'report.json': '{}' }, 'wrong');
    expect(wrong.valid).toBe(false);
    expect(wrong.errors.join(' ')).toMatch(/signature does not match/);
  });

  it('refuses to call a signed manifest verified without a key', () => {
    const signed = buildIntegrityManifest({ files: { 'report.json': '{}' }, key: 'correct' });
    const result = verifyIntegrityManifest(signed, { 'report.json': '{}' });
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/signed.*no key was supplied/);
  });

  it('detects a manifest whose own digests were rewritten', () => {
    const tampered = {
      ...manifest,
      files: { 'report.json': digestOf('something else', 'sha256') },
    };
    expect(verifyIntegrityManifest(tampered, { 'report.json': '{"a":1}' }).valid).toBe(false);
  });
});

describe('parseIntegrityManifest', () => {
  it('accepts a manifest this build wrote', () => {
    const manifest = buildIntegrityManifest({ files: { 'share.md': 'text' }, key: 'k' });
    expect(parseIntegrityManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });

  it('rejects a non-object, an unknown algorithm, and a bad files map', () => {
    expect(() => parseIntegrityManifest([])).toThrow(/must be a JSON object/);
    expect(() => parseIntegrityManifest({ algorithm: 'md5', files: {} })).toThrow(
      /unsupported algorithm/,
    );
    expect(() => parseIntegrityManifest({ algorithm: 'sha256', files: [] })).toThrow(
      /no "files" map/,
    );
    expect(() => parseIntegrityManifest({ algorithm: 'sha256', files: { a: 1 } })).toThrow(
      /not a digest string/,
    );
  });

  it('refuses a name that points outside the report directory', () => {
    // A manifest arrives with the artifact, from whoever sent it, so a name
    // that climbs out of the directory must never be resolved — otherwise a
    // crafted manifest steers a read of any file the process can reach.
    for (const name of [
      '../escape.txt',
      '../../../../etc/passwd',
      'payloads/../../escape.txt',
      '..\\escape.txt',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '..',
    ]) {
      expect(
        () => parseIntegrityManifest({ algorithm: 'sha256', files: { [name]: SHA256_ABC } }),
        `${name} should be refused`,
      ).toThrow(/outside the report directory/);
    }
  });

  it('still accepts a name that stays inside, including one that normalizes back in', () => {
    // `a/../b` resolves beside the manifest, so refusing it would break a
    // manifest a legitimate producer could write.
    for (const name of ['report.json', 'payloads/response-body-1.json', 'a/../b.json']) {
      const manifest = parseIntegrityManifest({
        algorithm: 'sha256',
        files: { [name]: SHA256_ABC },
      });
      expect(Object.keys(manifest.files)).toEqual([name]);
    }
  });
});

describe('file helpers', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'api-recon-integrity-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a manifest that the verifier accepts, and that never covers itself', async () => {
    const report = join(dir, 'report.json');
    const summary = join(dir, 'share.md');
    await writeFile(report, '{"endpoints":[]}', 'utf8');
    await writeFile(summary, '# API surface\n', 'utf8');

    const manifestPath = await writeIntegrityManifest([report, summary], dir, {
      algorithm: 'sha256',
      generatedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(manifestPath.endsWith(INTEGRITY_FILENAME)).toBe(true);

    const written = JSON.parse(await readFile(manifestPath, 'utf8')) as { files: object };
    expect(Object.keys(written.files).sort()).toEqual(['report.json', 'share.md']);

    const { verification } = await verifyManifestFromDisk(manifestPath);
    expect(verification.valid).toBe(true);
    expect(verification.checked).toBe(2);
  });

  it('fails verification once a covered file is edited', async () => {
    const report = join(dir, 'report.json');
    await writeFile(report, '{"endpoints":[]}', 'utf8');
    const manifestPath = await writeIntegrityManifest([report], dir, { algorithm: 'sha256' });

    await writeFile(report, '{"endpoints":[{"injected":true}]}', 'utf8');

    const { verification } = await verifyManifestFromDisk(manifestPath);
    expect(verification.valid).toBe(false);
    expect(verification.errors.join(' ')).toMatch(/report\.json: checksum mismatch/);
  });

  it('reads the HMAC key from a file and signs the manifest with it', async () => {
    const report = join(dir, 'report.json');
    await writeFile(report, '{}', 'utf8');
    const keyFile = join(dir, 'report.key');
    await writeFile(keyFile, '  super-secret-key\n', 'utf8');

    expect(await readSignKeyFile(keyFile)).toBe('super-secret-key');

    const manifestPath = await writeIntegrityManifest([report], dir, {
      algorithm: 'sha256',
      key: await readSignKeyFile(keyFile),
    });
    const { verification } = await verifyManifestFromDisk(manifestPath, keyFile);
    expect(verification.valid).toBe(true);
    expect(verification.signed).toBe(true);
  });

  it('refuses a missing or empty key file', async () => {
    await expect(readSignKeyFile(join(dir, 'nope.key'))).rejects.toThrow(/not found/);

    const empty = join(dir, 'empty.key');
    await writeFile(empty, '   \n', 'utf8');
    await expect(readSignKeyFile(empty)).rejects.toThrow(/empty/);
  });

  it('reports a missing manifest and malformed JSON clearly', async () => {
    await expect(verifyManifestFromDisk(join(dir, 'nope.json'))).rejects.toThrow(
      /Integrity manifest not found/,
    );

    const broken = join(dir, 'broken.json');
    await writeFile(broken, '{ not json', 'utf8');
    await expect(verifyManifestFromDisk(broken)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses a manifest that names a file outside the report directory', async () => {
    // The attack this guards: a crafted checksums.json sitting in the report
    // directory, naming a file above it with that file's real digest, which
    // used to verify as intact.
    const reports = join(dir, 'reports');
    await mkdir(reports, { recursive: true });
    const outside = join(dir, 'escape.txt');
    await writeFile(outside, 'not part of the artifact\n', 'utf8');
    const digest = digestOf(await readFile(outside), 'sha256');

    const manifestPath = join(reports, INTEGRITY_FILENAME);
    await writeFile(
      manifestPath,
      JSON.stringify({
        version: 1,
        algorithm: 'sha256',
        generatedAt: '2026-01-01T00:00:00.000Z',
        tool: { name: 'api-recon', version: '0.4.2' },
        files: { '../escape.txt': digest },
      }),
      'utf8',
    );

    await expect(verifyManifestFromDisk(manifestPath)).rejects.toThrow(
      /outside the report directory/,
    );
  });
});
