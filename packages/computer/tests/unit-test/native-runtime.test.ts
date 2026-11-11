import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from '@rstest/core';
import { createEmbeddedHelperExtractor } from '../../src/native-runtime';

describe('embedded computer helpers', () => {
  it('extracts once into a private executable directory and cleans up only that directory', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'computer-assets-test-'));
    const source = join(fixture, 'asset');
    writeFileSync(source, 'native-helper-bytes');
    const cleanups: Array<() => void> = [];
    try {
      const extract = createEmbeddedHelperExtractor(
        () => ({ 'phased-scroll': source }),
        () => {
          throw new Error('unexpected extraction failure');
        },
        (cleanup) => cleanups.push(cleanup),
      );
      const target = extract('phased-scroll');
      expect(target).not.toBeNull();
      expect(readFileSync(target!, 'utf8')).toBe('native-helper-bytes');
      expect(statSync(target!).mode & 0o100).toBe(0o100);
      expect(extract('phased-scroll')).toBe(target);
      expect(cleanups).toHaveLength(1);
      cleanups[0]();
      expect(existsSync(target!)).toBe(false);
      expect(existsSync(source)).toBe(true);
    } finally {
      for (const cleanup of cleanups) cleanup();
      rmSync(fixture, { recursive: true, force: true });
    }
  });
  it('leaves normal Node/package lookup available for absent or unreadable embedded assets', () => {
    let warnings = 0;
    const extract = createEmbeddedHelperExtractor(
      () => ({ 'phased-scroll': '/missing-midscene-native-asset' }),
      () => {
        warnings++;
      },
    );
    expect(extract('display-info')).toBeNull();
    expect(extract('phased-scroll')).toBeNull();
    expect(warnings).toBe(1);
  });
});
