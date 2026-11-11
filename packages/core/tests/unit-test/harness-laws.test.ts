/**
 * Every harness-contract law is proven, and every kept broken variant is
 * refuted on the law it breaks (gdp-wired). A refutation keeps the law
 * honest: it fails on an implementation that drops the rule it states.
 */
import { describe, expect, it } from '@rstest/core';
import { proveDecision } from 'gdp-wired';
import {
  cacheWriteLaws,
  cacheWriteRule,
  cacheWriteTreeRule,
  locateChainCacheFirstRule,
  locateChainLaws,
  locateChainRule,
  receiptDoubleFallbackRule,
  receiptDropDiffRule,
  receiptDropReasonRule,
  receiptLaws,
  receiptRetryBlockedRule,
  receiptRule,
  receiptSwallowBlockedRule,
  receiptTrustUnknownRule,
  treeQueryAnyPromptRule,
  treeQueryLaws,
  treeQueryLooseRule,
  treeQueryRule,
  treeRungAnyActionEditableRule,
  treeRungBlindRule,
  treeRungFirstMatchRule,
  treeRungIgnoreErrorRule,
  treeRungLaws,
  treeRungNoRecheckRule,
  treeRungRule,
} from '../laws/harness-laws';

type Laws = Array<{ name?: string }>;

function proven(laws: Laws) {
  for (const law of laws) {
    const verdict = proveDecision(law as never);
    expect({ law: law.name, ...verdict }).toMatchObject({
      law: law.name,
      proven: true,
      checked: true,
    });
  }
}

/** The broken variant breaks exactly the named laws, and proves the rest. */
function refutes(laws: Laws, broken: readonly string[]) {
  for (const law of laws) {
    const verdict = proveDecision(law as never);
    expect({ law: law.name, proven: verdict.proven }).toEqual({
      law: law.name,
      proven: !broken.includes(law.name ?? ''),
    });
  }
}

const EXACTLY_ONE =
  'the tree rung hits only on exactly one match, or for an input on the only editable one of several';
const RECHECK =
  'an exact query counts only whole-name equal matches: core re-checks the name';

describe('harness contract laws', () => {
  it('the tree rung laws are proven', () => proven(treeRungLaws(treeRungRule)));
  it.each([
    [
      'takes the first of several matches',
      treeRungFirstMatchRule,
      [
        EXACTLY_ONE,
        'only an input takes the editable one of several matches',
        'several editable matches abstain even for an input',
      ],
    ],
    [
      'trusts the interface for an exact name',
      treeRungNoRecheckRule,
      [EXACTLY_ONE, RECHECK],
    ],
    [
      'takes the editable one of several for any action',
      treeRungAnyActionEditableRule,
      [EXACTLY_ONE, 'only an input takes the editable one of several matches'],
    ],
    [
      'ignores a hidden verdict',
      treeRungBlindRule,
      ['a match reported not perceivable never hits'],
    ],
    [
      'keeps its matches when the interface throws',
      treeRungIgnoreErrorRule,
      ['an interface error abstains'],
    ],
  ] as const)('a tree rung that %s is refuted', (_label, rule, broken) =>
    refutes(treeRungLaws(rule as typeof treeRungRule), broken),
  );

  it('the tree query laws are proven', () =>
    proven(treeQueryLaws(treeQueryRule)));
  it.each([
    [
      'derives a substring query',
      treeQueryLooseRule,
      [
        'a query derived from a prompt is an exact whole-name query: no fuzzy matching',
      ],
    ],
    [
      'queries any prompt',
      treeQueryAnyPromptRule,
      ['a prompt with images or per-call context is never queried'],
    ],
  ] as const)('a tree query that %s is refuted', (_label, rule, broken) =>
    refutes(treeQueryLaws(rule as typeof treeQueryRule), broken),
  );

  it('the locate chain laws are proven', () =>
    proven(locateChainLaws(locateChainRule)));
  it('a chain that tries the cache before the tree is refuted', () =>
    refutes(locateChainLaws(locateChainCacheFirstRule), [
      'the cache is tried only after the tree missed',
      'a tree hit is used whenever plan and xpath missed',
    ]));

  it('the cache write laws are proven', () =>
    proven(cacheWriteLaws(cacheWriteRule)));
  it('a cache write that keeps tree hits is refuted', () =>
    refutes(cacheWriteLaws(cacheWriteTreeRule), [
      'a tree hit never writes the locate cache',
    ]));

  it('the receipt laws are proven', () => proven(receiptLaws(receiptRule)));
  it.each([
    [
      'retries a blocked action at coordinates',
      receiptRetryBlockedRule,
      ['only a stale receipt falls back to coordinates'],
    ],
    [
      'falls back twice on a stale ref',
      receiptDoubleFallbackRule,
      ['a stale receipt falls back to coordinates at most once'],
    ],
    [
      'swallows a blocked receipt',
      receiptSwallowBlockedRule,
      ['a blocked receipt throws'],
    ],
    [
      'drops the reason',
      receiptDropReasonRule,
      ['a blocked receipt throws with its reason'],
    ],
    [
      'trusts an unknown outcome',
      receiptTrustUnknownRule,
      ['an unknown outcome is never verified'],
    ],
    [
      'drops the diff',
      receiptDropDiffRule,
      ['an executed receipt carries its diff'],
    ],
  ] as const)('a receipt rule that %s is refuted', (_label, rule, broken) =>
    refutes(receiptLaws(rule as typeof receiptRule), broken),
  );
});
