import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type HelperName = 'phased-scroll' | 'display-info';
export interface MacPermissions {
  getAuthStatus(type: string): string;
  askForAccessibilityAccess(): void;
  askForScreenCaptureAccess(openPreferences?: boolean): void;
}
export interface ComputerNativeRuntime {
  helpers: Readonly<Partial<Record<HelperName, string>>>;
  permissions: { permissions: MacPermissions | null; loadError?: string };
}
let initialized: Readonly<ComputerNativeRuntime> | undefined;
/** Internal initialization: the ESM entry awaits this before consumers run. */
export function installComputerNativeRuntime(
  runtime: ComputerNativeRuntime,
): void {
  initialized ??= Object.freeze({
    helpers: Object.freeze({ ...runtime.helpers }),
    permissions: Object.freeze({ ...runtime.permissions }),
  });
}
export function computerNativeRuntime():
  | Readonly<ComputerNativeRuntime>
  | undefined {
  return initialized;
}

/** Extract Bun file-loader assets to a private executable directory. */
export function createEmbeddedHelperExtractor(
  assets: () => Readonly<Partial<Record<HelperName, string>>>,
  warn: (message: string, error: unknown) => void,
  onExit: (cleanup: () => void) => void = (cleanup) =>
    process.once('exit', cleanup),
): (name: HelperName) => string | null {
  let directory: string | undefined;
  const paths = new Map<HelperName, string>();
  return (name) => {
    const cached = paths.get(name);
    if (cached) return cached;
    const embedded = assets()[name];
    if (!embedded) return null;
    try {
      // Read before creating a directory, so missing assets leave no residue.
      const bytes = readFileSync(embedded);
      if (!directory) {
        directory = mkdtempSync(join(tmpdir(), 'midscene-computer-'));
        const ownedDirectory = directory;
        onExit(() => rmSync(ownedDirectory, { recursive: true, force: true }));
      }
      const target = join(directory, name);
      writeFileSync(target, bytes, { mode: 0o755 });
      paths.set(name, target);
      return target;
    } catch (error) {
      warn(`${name}: extracting the embedded helper failed`, error);
      return null;
    }
  };
}
