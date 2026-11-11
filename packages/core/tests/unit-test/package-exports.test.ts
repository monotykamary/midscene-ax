import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from '@rstest/core';

const root = resolve(__dirname, '../..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const entries = Object.entries(pkg.exports) as [
  string,
  Record<string, string>,
][];

describe('published Core entry points', () => {
  it.each(entries)(
    '%s maps every condition to existing source',
    (_name, entry) => {
      for (const target of Object.values(entry)) {
        const stem = target
          .replace(/^\.\/dist\/(lib|es|types)\//, '')
          .replace(/\.(d\.ts|mjs|js)$/, '');
        expect(
          ['ts', 'tsx'].some((extension) =>
            existsSync(resolve(root, `src/${stem}.${extension}`)),
          ),
          target,
        ).toBe(true);
      }
    },
  );

  it.each(Object.entries(pkg.typesVersions['*']) as [string, string[]][])(
    '%s uses the same declarations with legacy TypeScript resolution',
    (name, targets) => {
      const entry = pkg.exports[name === '.' ? '.' : `./${name}`];
      expect(targets).toEqual([entry.types]);
    },
  );
});
