#!/usr/bin/env node
/**
 * Pack the fork's packages for npm under our own scope, so a project installs midscene-ax next to (or instead of)
 * stock Midscene without a name clash:
 *
 *   node scripts/pack-ax.mjs --version 1.17.2-ax.1 [--scope @monotykamary] [--out .ax-packs]
 *   npm publish .ax-packs/<tarball> --access public --tag ax      (once per tarball, after reviewing them)
 *
 * Each package is copied (its `files` only, after `pnpm build`) and renamed: @midscene/core becomes
 * @monotykamary/midscene-core. Its workspace dependencies on the other forked packages become npm aliases
 * ("@midscene/core": "npm:@monotykamary/midscene-core@<version>"), so the built code keeps importing `@midscene/core`
 * and gets the fork, never stock Midscene. Nothing is published by this script.
 */
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    scope: { type: 'string', default: '@monotykamary' },
    out: { type: 'string', default: '.ax-packs' },
  },
});
if (!values.version || !/^\d+\.\d+\.\d+-ax\.\d+$/.test(values.version))
  throw new Error('--version must look like 1.17.2-ax.1');

/** The forked packages, in dependency order: folder under packages/ and the published name's suffix. */
const PACKAGES = [
  ['shared', 'midscene-shared'],
  ['core', 'midscene-core'],
  ['playground', 'midscene-playground'],
  ['web-integration', 'midscene-web'],
  ['computer', 'midscene-computer'],
];
const root = path.resolve(import.meta.dirname, '..');
const out = path.resolve(root, values.out);
const forked = new Map();
for (const [dir, suffix] of PACKAGES) {
  const original = JSON.parse(
    readFileSync(path.join(root, 'packages', dir, 'package.json'), 'utf8'),
  ).name;
  forked.set(original, `${values.scope}/${suffix}`);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [dir] of PACKAGES) {
  const source = path.join(root, 'packages', dir);
  const manifest = JSON.parse(
    readFileSync(path.join(source, 'package.json'), 'utf8'),
  );
  if (!existsSync(path.join(source, 'dist')))
    throw new Error(`${manifest.name}: no dist; run pnpm build first`);
  const stage = path.join(out, 'stage', dir);
  mkdirSync(stage, { recursive: true });
  for (const entry of [...(manifest.files ?? ['dist']), 'LICENSE']) {
    const from = path.join(source, entry);
    if (existsSync(from))
      cpSync(from, path.join(stage, entry), { recursive: true });
  }
  const alias = (deps) =>
    deps &&
    Object.fromEntries(
      Object.entries(deps).map(([name, range]) => {
        if (forked.has(name))
          return [name, `npm:${forked.get(name)}@${values.version}`];
        if (String(range).startsWith('workspace:'))
          throw new Error(
            `${manifest.name} depends on unforked workspace package ${name}`,
          );
        return [name, range];
      }),
    );
  const published = {
    ...manifest,
    name: forked.get(manifest.name),
    version: values.version,
    description: `${manifest.description ?? manifest.name} (midscene-ax fork of ${manifest.name})`,
    repository: {
      type: 'git',
      url: 'https://github.com/monotykamary/midscene-ax',
    },
    dependencies: alias(manifest.dependencies),
    peerDependencies: alias(manifest.peerDependencies),
    publishConfig: { access: 'public', tag: 'ax' },
  };
  // Left out of the published manifest (JSON.stringify drops undefined keys).
  published.private = undefined;
  published.devDependencies = undefined;
  // Native RDP helpers on other platforms can be built explicitly after install.
  // Never carry publish/install lifecycle hooks into the renamed package.
  published.scripts =
    dir === 'computer'
      ? { 'build:native': manifest.scripts['build:native'] }
      : undefined;
  writeFileSync(
    path.join(stage, 'package.json'),
    `${JSON.stringify(published, null, 2)}\n`,
  );
  const tarball = execFileSync(
    'npm',
    ['pack', '--silent', '--pack-destination', out],
    { cwd: stage },
  )
    .toString()
    .trim()
    .split('\n')
    .at(-1);
  console.log(
    `${published.name}@${published.version} -> ${path.join(values.out, tarball)}`,
  );
}
