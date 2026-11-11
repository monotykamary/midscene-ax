import type { ActReceipt, RefOperation } from '@midscene/core';
import { PRESS_KEYS } from './vendor/bhjs/interaction';

/**
 * The parts of a browser-harness-js `ActionResult` the receipt mapping reads.
 * Kept structural so the mapping can be tested without a browser.
 */
export interface HarnessActionResult {
  status: 'executed' | 'stale' | 'blocked' | 'outcome_unknown';
  reason?: string;
  verified: boolean | null;
  snapshot?: { id: string; diff: string };
  verificationError?: string;
}

/** Longest snapshot diff carried on a receipt; the rest is cut with a note. */
export const MAX_RECEIPT_DIFF_CHARS = 4000;

export interface ReceiptExtras {
  /** Set when the action ran on a rebound ref instead of the requested one. */
  rebound?: { from: string; to: string };
  /** Why a stale ref could not be rebound, appended to the reason. */
  rebindNote?: string;
}

function boundedDiff(diff: string): string {
  if (diff.length <= MAX_RECEIPT_DIFF_CHARS) {
    return diff;
  }
  const omitted = diff.length - MAX_RECEIPT_DIFF_CHARS;
  return `${diff.slice(0, MAX_RECEIPT_DIFF_CHARS)}\n[diff truncated: ${omitted} more characters]`;
}

/**
 * Map a browser-harness-js action result to the core `ActReceipt`.
 * - The four statuses carry over unchanged; anything else is an error.
 * - `verified` stays as the harness established it (`null` when nothing was
 *   read back), and an unknown outcome is never reported as verified.
 * - The harness's own reason (for example "not_interactable_or_unsupported:
 *   disabled. ...") is kept verbatim; a failed read-back is appended to it.
 * - `diff` and `revision` come from the snapshot taken after the action.
 */
export function toActReceipt(
  result: HarnessActionResult,
  extras: ReceiptExtras = {},
): ActReceipt {
  const { status } = result;
  if (
    status !== 'executed' &&
    status !== 'stale' &&
    status !== 'blocked' &&
    status !== 'outcome_unknown'
  ) {
    throw new Error(
      `browser-harness-js returned an unknown action status: ${JSON.stringify(result)}`,
    );
  }
  const reasons = [
    result.reason,
    result.verificationError &&
      `verification read failed: ${result.verificationError}`,
    extras.rebindNote,
  ].filter((part): part is string => !!part);
  const verified =
    status === 'outcome_unknown' && result.verified === true
      ? null
      : result.verified;
  return {
    status,
    verified: verified ?? null,
    ...(reasons.length ? { reason: reasons.join('; ') } : {}),
    ...(result.snapshot ? { diff: boundedDiff(result.snapshot.diff) } : {}),
    ...(result.snapshot ? { revision: result.snapshot.id } : {}),
    ...(extras.rebound ? { rebound: extras.rebound } : {}),
  };
}

/** The browser-harness-js Locator call for a core ref operation. */
export type HarnessLocatorCall =
  | { method: 'click' }
  | { method: 'fill'; text: string }
  | { method: 'press'; key: string }
  | { method: 'selectOption'; option: string }
  | { method: 'scrollIntoView' };

/**
 * The Locator call that performs a ref operation, or undefined when
 * browser-harness-js has no guarded equivalent (double click, right click,
 * hover, keys outside its allowlist). Core then acts at coordinates.
 */
export function harnessCallFor(
  operation: RefOperation,
  payload?: string,
): HarnessLocatorCall | undefined {
  switch (operation) {
    case 'tap':
      return { method: 'click' };
    case 'input':
      return typeof payload === 'string'
        ? { method: 'fill', text: payload }
        : undefined;
    case 'clear':
      return { method: 'fill', text: '' };
    case 'keyboardPress':
      return typeof payload === 'string' && Object.hasOwn(PRESS_KEYS, payload)
        ? { method: 'press', key: payload }
        : undefined;
    case 'select':
      return typeof payload === 'string'
        ? { method: 'selectOption', option: payload }
        : undefined;
    case 'scrollIntoView':
      return { method: 'scrollIntoView' };
    default:
      return undefined;
  }
}

/** The guard operation name a Locator call needs offered on the target. */
export function guardOperationFor(call: HarnessLocatorCall): string {
  switch (call.method) {
    case 'click':
      return 'click';
    case 'fill':
      return 'type';
    case 'press':
      return 'press';
    case 'selectOption':
      return 'select';
    case 'scrollIntoView':
      return 'scroll_into_view';
  }
}
