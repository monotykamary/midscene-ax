/**
 * The harness contract's laws, proven with gdp-wired: the locate chain's tree
 * rung, the queries it may derive, the order of the rungs and the cache rule,
 * and what a ref action's receipt does to the action.
 *
 * tests/unit-test/harness-laws.test.ts proves every law and refutes each kept
 * broken variant. tests/unit-test/harness-laws-bridge.test.ts holds the shipped
 * functions (src/agent/tree-locate.ts and the task builder that calls them) to
 * these rules on every state of the abstraction, so the proof is about the
 * code that ships.
 */
import { bool, fun, oneOf, when } from 'gdp-wired';

/** How many matches of a kind a query met. */
export const Count = oneOf('none', 'one', 'many');
/** A match's perceivability: reported shown, reported hidden, or not checked. */
export const Seen = oneOf('yes', 'no', 'unchecked');
export const Status = oneOf('executed', 'stale', 'blocked', 'outcome_unknown');
export const Verified = oneOf('yes', 'no', 'unknown');
export const Rung = oneOf('plan', 'xpath', 'tree', 'cache', 'ai');
export const Cacheable = oneOf('unset', 'yes', 'no');

type Env = Record<string, any>;

/**
 * Exactly one match counts: an exact query counts only whole-name equal
 * matches (core re-checks the name); any other query counts every match the
 * interface returned.
 */
const exactlyOne = ({ exact, equal, other }: Env) =>
  exact.and(equal.is('one')).or(
    exact.not().and(
      equal
        .is('one')
        .and(other.is('none'))
        .or(equal.is('none').and(other.is('one'))),
    ),
  );
const anyMatch = ({ exact, equal, other }: Env) =>
  equal
    .is('none')
    .not()
    .or(exact.not().and(other.is('none').not()));
const looseOne = ({ equal, other }: Env) =>
  equal
    .is('one')
    .and(other.is('none'))
    .or(equal.is('none').and(other.is('one')));

const treeRungInputs = {
  errored: bool,
  exact: bool,
  equal: Count,
  other: Count,
  seen: Seen,
};

/** The tree rung (resolveTreeLocate): exactly one perceivable match, or abstain. */
export const treeRungRule = fun('tree-rung')
  .inputs(treeRungInputs)
  .returns((env) => ({
    hit: env.errored.not().and(exactlyOne(env)).and(env.seen.is('no').not()),
  }));
/** Takes the first of several matches. */
export const treeRungFirstMatchRule = fun('tree-rung-first-match')
  .inputs(treeRungInputs)
  .returns((env) => ({
    hit: env.errored.not().and(anyMatch(env)).and(env.seen.is('no').not()),
  }));
/** Trusts the interface's name matching for an exact query. */
export const treeRungNoRecheckRule = fun('tree-rung-no-recheck')
  .inputs(treeRungInputs)
  .returns((env) => ({
    hit: env.errored.not().and(looseOne(env)).and(env.seen.is('no').not()),
  }));
/** Ignores a hidden verdict. */
export const treeRungBlindRule = fun('tree-rung-blind')
  .inputs(treeRungInputs)
  .returns((env) => ({ hit: env.errored.not().and(exactlyOne(env)) }));
/** Keeps the matches it had when the interface threw. */
export const treeRungIgnoreErrorRule = fun('tree-rung-ignore-error')
  .inputs(treeRungInputs)
  .returns((env) => ({
    hit: exactlyOne(env).and(env.seen.is('no').not()),
  }));

export function treeRungLaws(rule: typeof treeRungRule) {
  return [
    rule.law(
      'the tree rung hits only on exactly one match',
      (_env, out) => [out.hit],
      (_out, env) => exactlyOne(env),
    ),
    rule.law(
      'an exact query counts only whole-name equal matches: core re-checks the name',
      (env) => [env.exact, env.equal.is('none')],
      (out) => out.hit.not(),
    ),
    rule.law(
      'a match reported not perceivable never hits',
      (env) => [env.seen.is('no')],
      (out) => out.hit.not(),
    ),
    rule.law(
      'an interface error abstains',
      (env) => [env.errored],
      (out) => out.hit.not(),
    ),
  ];
}

const treeQueryInputs = {
  explicit: bool,
  textPrompt: bool,
  context: bool,
  blank: bool,
};

/** The query the rung asks (treeQueryForLocate): never looser than an exact whole name. */
export const treeQueryRule = fun('tree-query')
  .inputs(treeQueryInputs)
  .returns(({ explicit, textPrompt, context, blank }) => {
    const derived = explicit
      .not()
      .and(textPrompt)
      .and(context.not())
      .and(blank.not());
    return { queried: explicit.or(derived), derived, derivedExact: derived };
  });
/** Derives a substring query from a prompt. */
export const treeQueryLooseRule = fun('tree-query-loose')
  .inputs(treeQueryInputs)
  .returns(({ explicit, textPrompt, context, blank }) => {
    const derived = explicit
      .not()
      .and(textPrompt)
      .and(context.not())
      .and(blank.not());
    return {
      queried: explicit.or(derived),
      derived,
      derivedExact: derived.and(derived.not()),
    };
  });
/** Queries the tree for any prompt, images and context included. */
export const treeQueryAnyPromptRule = fun('tree-query-any-prompt')
  .inputs(treeQueryInputs)
  .returns(({ explicit, blank }) => {
    const derived = explicit.not().and(blank.not());
    return { queried: explicit.or(derived), derived, derivedExact: derived };
  });

export function treeQueryLaws(rule: typeof treeQueryRule) {
  return [
    rule.law(
      'a query derived from a prompt is an exact whole-name query: no fuzzy matching',
      (_env, out) => [out.derived],
      (out) => out.derivedExact,
    ),
    rule.law(
      'a prompt with images or per-call context is never queried',
      (env) => [env.explicit.not(), env.textPrompt.not().or(env.context)],
      (out) => out.queried.not(),
    ),
  ];
}

const chainInputs = { plan: bool, xpath: bool, tree: bool, cache: bool };

/** The locate chain (locateRungRuns, locateSource): plan, xpath, tree, cache, then AI. */
export const locateChainRule = fun('locate-chain')
  .inputs(chainInputs)
  .returns(({ plan, xpath, tree, cache }) => {
    const runsXpath = plan.not();
    const runsTree = runsXpath.and(xpath.not());
    const runsCache = runsTree.and(tree.not());
    const runsAi = runsCache.and(cache.not());
    return {
      runsXpath,
      runsTree,
      runsCache,
      runsAi,
      fromPlan: plan,
      fromXpath: runsXpath.and(xpath),
      fromTree: runsTree.and(tree),
      fromCache: runsCache.and(cache),
      fromAi: runsAi,
    };
  });
/** Tries the cache before the tree. */
export const locateChainCacheFirstRule = fun('locate-chain-cache-first')
  .inputs(chainInputs)
  .returns(({ plan, xpath, tree, cache }) => {
    const runsXpath = plan.not();
    const runsCache = runsXpath.and(xpath.not());
    const runsTree = runsCache.and(cache.not());
    const runsAi = runsTree.and(tree.not());
    return {
      runsXpath,
      runsTree,
      runsCache,
      runsAi,
      fromPlan: plan,
      fromXpath: runsXpath.and(xpath),
      fromTree: runsTree.and(tree),
      fromCache: runsCache.and(cache),
      fromAi: runsAi,
    };
  });

const SOURCES = ['fromPlan', 'fromXpath', 'fromTree', 'fromCache', 'fromAi'];

export function locateChainLaws(rule: typeof locateChainRule) {
  const laws = [
    rule.law(
      'a plan hit always wins',
      (env) => [env.plan],
      (out) => out.fromPlan,
    ),
    rule.law(
      'xpath is tried only after the plan missed',
      (_env, out) => [out.runsXpath],
      (_out, env) => env.plan.not(),
    ),
    rule.law(
      'the tree is tried only after plan and xpath missed',
      (_env, out) => [out.runsTree],
      (_out, env) => env.plan.not().and(env.xpath.not()),
    ),
    rule.law(
      'the cache is tried only after the tree missed',
      (_env, out) => [out.runsCache],
      (_out, env) => env.plan.not().and(env.xpath.not()).and(env.tree.not()),
    ),
    rule.law(
      'AI locate runs only when every rung missed',
      (_env, out) => [out.runsAi],
      (_out, env) =>
        env.plan
          .not()
          .and(env.xpath.not())
          .and(env.tree.not())
          .and(env.cache.not()),
    ),
    rule.law(
      'a tree hit is used whenever plan and xpath missed',
      (env) => [env.tree, env.plan.not(), env.xpath.not()],
      (out) => out.fromTree,
    ),
  ];
  for (const [i, a] of SOURCES.entries())
    for (const b of SOURCES.slice(i + 1))
      laws.push(
        rule.law(
          `the element never comes from both ${a.slice(4).toLowerCase()} and ${b.slice(4).toLowerCase()}`,
          (_env, out) => [out[a]],
          (out) => out[b].not(),
        ),
      );
  return laws;
}

const cacheInputs = {
  found: bool,
  cacheEnabled: bool,
  source: Rung,
  cacheExists: bool,
  cacheable: Cacheable,
};

/** The locate cache write (locateCacheWritable). */
export const cacheWriteRule = fun('cache-write')
  .inputs(cacheInputs)
  .returns(({ found, cacheEnabled, source, cacheExists, cacheable }) => ({
    write: found
      .and(cacheEnabled)
      .and(source.is('cache').not())
      .and(source.is('tree').not())
      .and(source.is('plan').not().or(cacheExists.not()))
      .and(cacheable.is('no').not()),
  }));
/** The write before the tree rung existed: a tree hit was written like any other. */
export const cacheWriteTreeRule = fun('cache-write-tree')
  .inputs(cacheInputs)
  .returns(({ found, cacheEnabled, source, cacheExists, cacheable }) => ({
    write: found
      .and(cacheEnabled)
      .and(source.is('cache').not())
      .and(source.is('plan').not().or(cacheExists.not()))
      .and(cacheable.is('no').not()),
  }));

export function cacheWriteLaws(rule: typeof cacheWriteRule) {
  return [
    rule.law(
      'a tree hit never writes the locate cache',
      (env) => [env.source.is('tree')],
      (out) => out.write.not(),
    ),
    rule.law(
      'a cache hit is never written back',
      (env) => [env.source.is('cache')],
      (out) => out.write.not(),
    ),
    rule.law(
      'cacheable false never writes the cache',
      (env) => [env.cacheable.is('no')],
      (out) => out.write.not(),
    ),
    rule.law(
      'nothing is written when nothing was found or there is no task cache',
      (env) => [env.found.not().or(env.cacheEnabled.not())],
      (out) => out.write.not(),
    ),
  ];
}

const receiptInputs = {
  status: Status,
  verified: Verified,
  reason: bool,
  diff: bool,
};

const receiptReturns = ({ status, verified, reason, diff }: Env) => ({
  coordinates: status.is('stale'),
  coordinateCalls: when(status.is('stale'), 1, 0),
  throws: status.is('blocked'),
  verifiedYes: verified.is('yes').and(status.is('outcome_unknown').not()),
  reasonKept: reason,
  diffKept: diff,
});

/** A ref action's receipt (receiptOutcome and the task builder's callByRef). */
export const receiptRule = fun('ref-receipt')
  .inputs(receiptInputs)
  .returns(receiptReturns);
/** Retries a blocked action at coordinates. */
export const receiptRetryBlockedRule = fun('ref-receipt-retry-blocked')
  .inputs(receiptInputs)
  .returns((env) => {
    const back = env.status.is('stale').or(env.status.is('blocked'));
    return {
      ...receiptReturns(env),
      coordinates: back,
      coordinateCalls: when(back, 1, 0),
    };
  });
/** Falls back to coordinates twice on a stale ref. */
export const receiptDoubleFallbackRule = fun('ref-receipt-double-fallback')
  .inputs(receiptInputs)
  .returns((env) => ({
    ...receiptReturns(env),
    coordinateCalls: when(env.status.is('stale'), 2, 0),
  }));
/** Swallows a blocked receipt. */
export const receiptSwallowBlockedRule = fun('ref-receipt-swallow-blocked')
  .inputs(receiptInputs)
  .returns((env) => ({
    ...receiptReturns(env),
    throws: env.status.is('blocked').and(env.status.is('blocked').not()),
  }));
/** Throws without the receipt's reason. */
export const receiptDropReasonRule = fun('ref-receipt-drop-reason')
  .inputs(receiptInputs)
  .returns((env) => ({
    ...receiptReturns(env),
    reasonKept: env.reason.and(env.status.is('blocked').not()),
  }));
/** Keeps a verified success on an unknown outcome. */
export const receiptTrustUnknownRule = fun('ref-receipt-trust-unknown')
  .inputs(receiptInputs)
  .returns((env) => ({
    ...receiptReturns(env),
    verifiedYes: env.verified.is('yes'),
  }));
/** Drops an executed receipt's diff. */
export const receiptDropDiffRule = fun('ref-receipt-drop-diff')
  .inputs(receiptInputs)
  .returns((env) => ({
    ...receiptReturns(env),
    diffKept: env.diff.and(env.status.is('executed').not()),
  }));

export function receiptLaws(rule: typeof receiptRule) {
  return [
    rule.law(
      'only a stale receipt falls back to coordinates',
      (_env, out) => [out.coordinates],
      (_out, env) => env.status.is('stale'),
    ),
    rule.law(
      'a stale receipt falls back to coordinates at most once',
      () => [],
      (out) => out.coordinateCalls.atMost(1),
    ),
    rule.law(
      'a blocked receipt throws',
      (env) => [env.status.is('blocked')],
      (out) => out.throws,
    ),
    rule.law(
      'a blocked receipt throws with its reason',
      (env) => [env.status.is('blocked'), env.reason],
      (out) => out.reasonKept,
    ),
    rule.law(
      'an unknown outcome is never verified',
      (env) => [env.status.is('outcome_unknown')],
      (out) => out.verifiedYes.not(),
    ),
    rule.law(
      'an executed receipt carries its diff',
      (env) => [env.status.is('executed'), env.diff],
      (out) => out.diffKept,
    ),
  ];
}
