import {
  type HelperName,
  type MacPermissions,
  installComputerNativeRuntime,
} from './native-runtime';

/** ESM-only initializer. Literal imports let Bun include native file assets. */
export async function initializeComputerNativeRuntime(): Promise<void> {
  if (process.platform !== 'darwin') return;
  const helpers: Partial<Record<HelperName, string>> = {};
  const loadHelper = async (
    name: HelperName,
    load: () => Promise<{ default: string }>,
  ) => {
    try {
      helpers[name] = (await load()).default;
    } catch {
      /* Node uses packaged files. */
    }
  };
  await Promise.all([
    // Kept external by Rslib: paths are relative to dist/es/index.mjs.
    loadHelper(
      'phased-scroll',
      () =>
        import('../../bin/darwin/phased-scroll', { with: { type: 'file' } }),
    ),
    loadHelper(
      'display-info',
      () => import('../../bin/darwin/display-info', { with: { type: 'file' } }),
    ),
  ]);
  let permissions: { permissions: MacPermissions | null; loadError?: string };
  try {
    const loaded = await import('node-mac-permissions');
    permissions = { permissions: loaded.default };
  } catch (error) {
    permissions = {
      permissions: null,
      loadError: error instanceof Error ? error.message : String(error),
    };
  }
  installComputerNativeRuntime({ helpers, permissions });
}
