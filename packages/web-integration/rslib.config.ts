import { defineConfig } from '@rslib/core';
import { createTypeCheckPlugin } from '../../scripts/rsbuild-utils.ts';
import { version } from './package.json';

export default defineConfig({
  lib: [
    {
      bundle: false,
      output: {
        distPath: {
          root: 'dist/lib',
        },
      },
      format: 'cjs',
      syntax: 'es2020',
    },
    {
      bundle: false,
      output: {
        distPath: {
          root: 'dist/es',
        },
      },
      format: 'esm',
      syntax: 'es2020',
      dts: {
        distPath: 'dist/types',
      },
    },
  ],
  source: {
    // Bundleless: compile every TypeScript file, but not the LICENSE and
    // UPSTREAM notes kept beside vendored code.
    entry: {
      index: ['./src/**/*.ts'],
    },
    tsconfigPath: 'tsconfig.build.json',
    define: {
      __VERSION__: JSON.stringify(version),
    },
  },
  output: {
    sourceMap: true,
  },
  plugins: [createTypeCheckPlugin()],
});
