/**
 * Text redaction for serialized dumps and reports.
 *
 * A host that resolves secrets before handing an instruction to the agent (a
 * credential vault, a CI secret store) cannot keep those values out of the
 * report on its own: the resolved string reaches the model, and the execution
 * name, `userInstruction`, planning logs, the `value` of an Input action and
 * the raw model response are all serialized into the dump.
 *
 * Redaction is opt-in and sits where every one of those strings is
 * serialized. A host registers a secret (or a custom redactor), and every
 * string written to a report, a persisted dump or a Markdown export goes
 * through it. Runtime behavior is untouched: the agent and the model still see
 * real values.
 */

import { getDebug } from '@midscene/shared/logger';

const warnRedaction = getDebug('dump:redaction', { console: true });

export type DumpTextRedactor = (text: string) => string;

export interface DumpSecretOptions {
  /** Replacement written in place of the secret. Defaults to `[REDACTED]`. */
  mask?: string;
}

const DEFAULT_SECRET_MASK = '[REDACTED]';

const redactors = new Set<DumpTextRedactor>();

/**
 * Register a redactor applied to every string in a serialized dump.
 * Returns a disposer that removes it again.
 */
export function registerDumpTextRedactor(
  redactor: DumpTextRedactor,
): () => void {
  redactors.add(redactor);
  return () => {
    redactors.delete(redactor);
  };
}

function jsonStringBody(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Register a secret value to mask in every serialized dump and report.
 *
 * Strings such as a raw model response can themselves hold JSON, where the
 * secret appears escaped (`"` as `\"`, `\` as `\\`). The JSON-escaped forms,
 * up to two levels deep, are masked as well as the raw value.
 * Returns a disposer that removes the secret again.
 */
export function registerDumpSecret(
  secret: string,
  options?: DumpSecretOptions,
): () => void {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error('registerDumpSecret requires a non-empty string');
  }
  const mask = options?.mask ?? DEFAULT_SECRET_MASK;
  const escapedOnce = jsonStringBody(secret);
  const forms = Array.from(
    new Set([secret, escapedOnce, jsonStringBody(escapedOnce)]),
  ).sort((left, right) => right.length - left.length);

  return registerDumpTextRedactor((text) =>
    forms.reduce(
      (redacted, form) =>
        redacted.includes(form) ? redacted.split(form).join(mask) : redacted,
      text,
    ),
  );
}

/** Drop every registered redactor and secret. Intended for tests. */
export function clearDumpTextRedactors(): void {
  redactors.clear();
}

/** Whether any redactor or secret is registered. */
export function hasDumpTextRedactor(): boolean {
  return redactors.size > 0;
}

/**
 * Run `text` through every registered redactor. One that throws only loses its
 * own contribution: the remaining redactors still run, because a partially
 * redacted report is better than a failed report write that leaves the
 * previous, unredacted one in place.
 */
export function redactDumpText(text: string): string {
  if (redactors.size === 0) return text;
  let out = text;
  for (const redactor of redactors) {
    try {
      const next = redactor(out);
      if (typeof next === 'string') out = next;
    } catch (error) {
      // Keep whatever the other redactors produced.
      warnRedaction('a dump text redactor failed and was skipped', error);
    }
  }
  return out;
}

/**
 * JSON.stringify replacer that redacts string values. Base64 image data URLs
 * are left alone: a coincidental match would corrupt the image bytes.
 */
export function redactDumpJsonValue(_key: string, value: unknown): unknown {
  if (typeof value !== 'string' || redactors.size === 0) return value;
  if (/^data:image\/[^,]*;base64,/i.test(value)) return value;
  return redactDumpText(value);
}
