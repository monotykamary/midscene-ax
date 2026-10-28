import type { AbstractInterface } from '@/device';
import type {
  ActReceipt,
  DetailedLocateParam,
  RefOperation,
  TreeLocateRecord,
  TreeMatch,
  TreeQuery,
} from '@/types';

/**
 * Harness contract helpers: the deterministic tree rung of the locate chain
 * and the mapping from located actions to ref operations. Everything here is
 * inert for interfaces that do not implement `locateInTree` / `actOnRef`.
 */

export const TREE_HIT_SOURCE = 'Accessibility tree';

export function normalizeTreeName(name: string): string {
  return name.replace(/\s+/g, ' ').trim();
}

/**
 * The tree address for a locate param: the explicit `tree` query when given,
 * otherwise an exact-name query built from a plain-string prompt. Prompts with
 * images or per-call context are left to AI locate, and nothing looser than an
 * exact whole-name match is ever derived from prompt text.
 */
export function treeQueryForLocate(
  locateParam: DetailedLocateParam,
): TreeQuery | undefined {
  if (locateParam.tree) {
    return locateParam.tree;
  }
  const { prompt } = locateParam;
  if (typeof prompt !== 'string' || locateParam.context) {
    return undefined;
  }
  const name = normalizeTreeName(prompt);
  return name ? { name, exact: true } : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface TreeLocateOutcome {
  match?: TreeMatch;
  record: TreeLocateRecord;
}

/**
 * Bind a tree query to exactly one perceivable element, or abstain with a
 * reason. Zero matches, several matches, a failed perceivability check and
 * interface errors all abstain; cancellation is rethrown.
 */
export async function resolveTreeLocate(
  device: AbstractInterface,
  query: TreeQuery,
  signal?: AbortSignal,
): Promise<TreeLocateOutcome> {
  const abstain = (reason: string, matchCount?: number): TreeLocateOutcome => ({
    record: {
      query,
      outcome: 'abstained',
      reason,
      ...(matchCount !== undefined ? { matchCount } : {}),
    },
  });

  let matches: TreeMatch[];
  try {
    matches = (await device.locateInTree!(query, signal)) ?? [];
  } catch (error) {
    signal?.throwIfAborted();
    return abstain(`locateInTree failed: ${errorMessage(error)}`);
  }
  signal?.throwIfAborted();

  // Core decides what an exact name means, whatever the interface returned.
  if ('name' in query && query.exact) {
    const wanted = normalizeTreeName(query.name);
    matches = matches.filter(
      (match) => normalizeTreeName(match.name ?? '') === wanted,
    );
  }

  if (matches.length === 0) {
    return abstain('no element matched', 0);
  }
  if (matches.length > 1) {
    return abstain(
      `ambiguous: ${matches.length} elements matched`,
      matches.length,
    );
  }

  const [match] = matches;
  let perceivability = match.perceivable;
  if (!perceivability && device.perceivable) {
    try {
      perceivability = await device.perceivable(match, signal);
    } catch (error) {
      signal?.throwIfAborted();
      return abstain(`perceivability check failed: ${errorMessage(error)}`, 1);
    }
    signal?.throwIfAborted();
  }
  if (perceivability && !perceivability.perceivable) {
    return abstain(
      `not perceivable${perceivability.why ? `: ${perceivability.why}` : ''}`,
      1,
    );
  }

  return {
    match,
    record: {
      query,
      outcome: 'hit',
      matchCount: 1,
      ref: match.ref,
      ...(match.revision !== undefined ? { revision: match.revision } : {}),
    },
  };
}

/** The rungs of the locate chain, in the order they are tried. */
export const LOCATE_RUNGS = ['plan', 'xpath', 'tree', 'cache', 'ai'] as const;
export type LocateRung = (typeof LOCATE_RUNGS)[number];
/** Which rungs before AI hit, as far as the chain has run. */
export type LocateHits = Partial<Record<Exclude<LocateRung, 'ai'>, boolean>>;

/** A rung is tried only when every rung before it missed. */
export function locateRungRuns(rung: LocateRung, hits: LocateHits): boolean {
  for (const earlier of LOCATE_RUNGS) {
    if (earlier === rung) return true;
    if (earlier !== 'ai' && hits[earlier]) return false;
  }
  return false;
}

/** The rung whose element the chain uses: the first that hit, else AI. */
export function locateSource(hits: LocateHits): LocateRung {
  return LOCATE_RUNGS.find((rung) => rung !== 'ai' && hits[rung]) ?? 'ai';
}

/**
 * Whether a located element is written to the locate cache. A cache hit is
 * not written back, a tree hit never is (the tree resolves again on the next
 * run, and a cached point must not stand in for it when it later abstains), a
 * plan hit only when no cache entry exists yet, and never against
 * `cacheable: false`.
 */
export function locateCacheWritable(input: {
  found: boolean;
  cacheEnabled: boolean;
  source: LocateRung;
  cacheExists: boolean;
  cacheable?: boolean;
}): boolean {
  return (
    input.found &&
    input.cacheEnabled &&
    input.source !== 'cache' &&
    input.source !== 'tree' &&
    (input.source !== 'plan' || !input.cacheExists) &&
    input.cacheable !== false
  );
}

/**
 * What a ref action's receipt does to the action: `executed` is done and kept
 * as returned (its diff included), `stale` falls back to the coordinate path,
 * `blocked` throws with the receipt, and `outcome_unknown` is done without a
 * verified success. Undefined for a status outside the contract.
 */
export function receiptOutcome(
  receipt: ActReceipt,
): { path: 'done' | 'coordinates' | 'throw'; receipt: ActReceipt } | undefined {
  switch (receipt.status) {
    case 'executed':
      return { path: 'done', receipt };
    case 'stale':
      return { path: 'coordinates', receipt };
    case 'blocked':
      return { path: 'throw', receipt };
    case 'outcome_unknown':
      return {
        path: 'done',
        receipt: {
          ...receipt,
          verified: receipt.verified === true ? null : receipt.verified,
        },
      };
    default:
      return undefined;
  }
}

export interface RefOperationPlan {
  operation: RefOperation;
  payload?: string;
}

const pointerOperations: Record<string, RefOperation> = {
  Tap: 'tap',
  DoubleClick: 'doubleClick',
  RightClick: 'rightClick',
  Hover: 'hover',
  ClearInput: 'clear',
};

/**
 * The ref operation for an action whose `locate` came from the tree, or
 * undefined to keep the coordinate path. Deliberately small: options a ref
 * operation cannot carry (typeOnly input, typing delays, input strategies,
 * keyboard dismissal) stay on the coordinate path.
 */
export function refOperationForAction(
  actionName: string,
  param: Record<string, any> | undefined,
): RefOperationPlan | undefined {
  const pointerOperation = pointerOperations[actionName];
  if (pointerOperation) {
    return { operation: pointerOperation };
  }
  if (actionName === 'KeyboardPress') {
    return typeof param?.keyName === 'string' && param.keyName
      ? { operation: 'keyboardPress', payload: param.keyName }
      : undefined;
  }
  if (actionName === 'Input') {
    if (
      param?.autoDismissKeyboard !== undefined ||
      param?.keyboardTypeDelay !== undefined ||
      param?.inputStrategy !== undefined
    ) {
      return undefined;
    }
    const mode = param?.mode ?? 'replace';
    if (mode === 'clear') {
      return { operation: 'clear' };
    }
    if (mode === 'replace' && typeof param?.value === 'string' && param.value) {
      return { operation: 'input', payload: param.value };
    }
  }
  return undefined;
}

/** Thrown when `actOnRef` refuses an action; the planner sees the reason. */
export class RefActionBlockedError extends Error {
  readonly receipt: ActReceipt;

  constructor(actionName: string, ref: string, receipt: ActReceipt) {
    super(
      `${actionName} was blocked on element ${ref}: ${receipt.reason || 'no reason given'}`,
    );
    this.name = 'RefActionBlockedError';
    this.receipt = receipt;
  }
}
