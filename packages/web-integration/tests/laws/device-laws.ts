/**
 * The browser-harness-js device's laws, proven with gdp-wired: how a stale
 * ref is rebound, which operations go through the guard, and how matches in
 * frames are reported to core's tree rung (whose own laws live in
 * packages/core/tests/laws/harness-laws.ts).
 *
 * tests/unit-test/device-laws.test.ts proves every law and refutes each kept
 * broken variant; tests/unit-test/device-laws-bridge.test.ts holds the device's
 * real methods (actOnRef, supportsRefOperation, locateInTree, with the
 * browser stubbed out) to these rules on every state of the abstraction.
 */
import { bool, fun, oneOf, when } from 'gdp-wired';

export const Count = oneOf('none', 'one', 'many');
export const Status = oneOf('executed', 'stale', 'blocked', 'outcome_unknown');
export const Operation = oneOf(
  'tap',
  'input',
  'clear',
  'keyboardPress',
  'select',
  'scrollIntoView',
  'hover',
  'doubleClick',
  'rightClick',
);
/** What the guard offers on the element: the operation needed, only a scroll, something else, or no candidate. */
export const Offered = oneOf('needed', 'scrollOnly', 'other', 'none');

type Env = Record<string, any>;

const rebindInputs = {
  first: Status,
  known: bool,
  rebindErrored: bool,
  candidates: Count,
  perceivable: bool,
  second: Status,
};

const rebindReturns = (rebinds: any, env: Env) => ({
  rebound: rebinds,
  performs: when(rebinds, 2, 1),
  finalStale: rebinds
    .and(env.second.is('stale'))
    .or(rebinds.not().and(env.first.is('stale'))),
});
const rebinds = (env: Env) =>
  env.first
    .is('stale')
    .and(env.known)
    .and(env.rebindErrored.not())
    .and(env.candidates.is('one'))
    .and(env.perceivable);

/** actOnRef: a stale ref is rebound once, by a unique perceivable identity, or returned stale. */
export const rebindRule = fun('rebind')
  .inputs(rebindInputs)
  .returns((env) => rebindReturns(rebinds(env), env));
/** Rebinds again when the rebound element is stale too. */
export const rebindTwiceRule = fun('rebind-twice')
  .inputs(rebindInputs)
  .returns((env) => ({
    ...rebindReturns(rebinds(env), env),
    performs: when(
      rebinds(env).and(env.second.is('stale')),
      3,
      when(rebinds(env), 2, 1),
    ),
  }));
/** Rebinds to the first of several look-alikes. */
export const rebindFirstRule = fun('rebind-first')
  .inputs(rebindInputs)
  .returns((env) => {
    const r = env.first
      .is('stale')
      .and(env.known)
      .and(env.rebindErrored.not())
      .and(env.candidates.is('none').not())
      .and(env.perceivable);
    return rebindReturns(r, env);
  });
/** Rebinds to a look-alike it has not checked is shown. */
export const rebindHiddenRule = fun('rebind-hidden')
  .inputs(rebindInputs)
  .returns((env) => {
    const r = env.first
      .is('stale')
      .and(env.known)
      .and(env.rebindErrored.not())
      .and(env.candidates.is('one'));
    return rebindReturns(r, env);
  });
/** Rebinds a ref that is not from this page's snapshots. */
export const rebindUnknownRule = fun('rebind-unknown')
  .inputs(rebindInputs)
  .returns((env) => {
    const r = env.first
      .is('stale')
      .and(env.rebindErrored.not())
      .and(env.candidates.is('one'))
      .and(env.perceivable);
    return rebindReturns(r, env);
  });

export function rebindLaws(rule: typeof rebindRule) {
  // The outputs come from shared returns builders, so their kinds are read as
  // conditions and terms here.
  const law = rule.law.bind(rule) as (
    name: string,
    premises: (env: Env, out: Env) => unknown[],
    conclusion: (out: Env, env: Env) => unknown,
  ) => ReturnType<typeof rule.law>;
  return [
    law(
      'a stale ref is rebound at most once',
      () => [],
      (out) => out.performs.atMost(2),
    ),
    law(
      'only a stale first attempt is rebound',
      (_env, out) => [out.rebound],
      (_out, env) => env.first.is('stale'),
    ),
    law(
      'a rebind needs exactly one element with the same identity',
      (_env, out) => [out.rebound],
      (_out, env) => env.candidates.is('one'),
    ),
    law(
      'a rebind needs that element to be perceivable',
      (_env, out) => [out.rebound],
      (_out, env) => env.perceivable,
    ),
    law(
      "a ref from another page's snapshots is never rebound",
      (env) => [env.known.not()],
      (out) => out.rebound.not(),
    ),
    law(
      'a stale ref that is not rebound is returned stale',
      (env, out) => [env.first.is('stale'), out.rebound.not()],
      (out) => out.finalStale,
    ),
  ];
}

const supportInputs = {
  operation: Operation,
  payload: bool,
  keyAllowed: bool,
  known: bool,
  mainFrame: bool,
  probeFailed: bool,
  offered: Offered,
  refStill: bool,
  notOperable: bool,
};

/** Whether browser-harness-js has a guarded call for the operation (harnessCallFor). */
const hasCall = ({ operation, payload, keyAllowed }: Env) =>
  operation
    .is('tap')
    .or(operation.is('clear'))
    .or(operation.is('scrollIntoView'))
    .or(operation.is('input').and(payload))
    .or(operation.is('select').and(payload))
    .or(operation.is('keyboardPress').and(payload).and(keyAllowed));

const supportedWith = (call: any, env: Env, otherOffered: any) =>
  call.and(
    env.known.not().or(
      env.mainFrame.and(
        env.operation
          .is('scrollIntoView')
          .or(env.probeFailed)
          .or(env.offered.is('needed'))
          .or(env.offered.is('scrollOnly'))
          .or(otherOffered)
          .or(
            env.offered
              .is('none')
              .and(env.refStill.not().or(env.notOperable.not())),
          ),
      ),
    ),
  );

/**
 * supportsRefOperation: true sends the action through the guard by ref; false
 * keeps core's coordinate path. An unknown ref answers true (actOnRef reports
 * it stale) and a failed probe answers true (actOnRef revalidates).
 */
export const supportRule = fun('ref-operation-support')
  .inputs(supportInputs)
  .returns((env) => ({
    supported: supportedWith(
      hasCall(env),
      env,
      env.offered.is('other').and(env.offered.is('other').not()),
    ),
  }));
/** Answers yes for every operation. */
export const supportEverythingRule = fun('ref-operation-support-everything')
  .inputs(supportInputs)
  .returns((env) => ({ supported: env.known.or(env.known.not()) }));
/** Hovers by ref. */
export const supportHoverRule = fun('ref-operation-support-hover')
  .inputs(supportInputs)
  .returns((env) => ({
    supported: supportedWith(
      hasCall(env).or(env.operation.is('hover')),
      env,
      env.offered.is('other').and(env.offered.is('other').not()),
    ),
  }));
/** Presses any key by ref, chords included. */
export const supportAnyKeyRule = fun('ref-operation-support-any-key')
  .inputs(supportInputs)
  .returns((env) => ({
    supported: supportedWith(
      hasCall({ ...env, keyAllowed: env.keyAllowed.or(env.keyAllowed.not()) }),
      env,
      env.offered.is('other').and(env.offered.is('other').not()),
    ),
  }));
/** Trusts the guard with a control it does not offer the operation on. */
export const supportAnyControlRule = fun('ref-operation-support-any-control')
  .inputs(supportInputs)
  .returns((env) => ({
    supported: supportedWith(hasCall(env), env, env.offered.is('other')),
  }));

export function supportLaws(rule: typeof supportRule) {
  // The outputs come from shared returns builders, so their kinds are read as
  // conditions and terms here.
  const law = rule.law.bind(rule) as (
    name: string,
    premises: (env: Env, out: Env) => unknown[],
    conclusion: (out: Env, env: Env) => unknown,
  ) => ReturnType<typeof rule.law>;
  return [
    law(
      'hover, double click and right click keep the coordinate path',
      (env) => [
        env.operation
          .is('hover')
          .or(env.operation.is('doubleClick'))
          .or(env.operation.is('rightClick')),
      ],
      (out) => out.supported.not(),
    ),
    law(
      'a key the guard cannot press, such as a chord, keeps the coordinate path',
      (env) => [env.operation.is('keyboardPress'), env.keyAllowed.not()],
      (out) => out.supported.not(),
    ),
    law(
      'a control the guard does not operate, such as a date input or a slider, keeps the coordinate path',
      (env) => [
        env.known,
        env.operation.is('scrollIntoView').not(),
        env.probeFailed.not(),
        env.offered
          .is('other')
          .or(env.offered.is('none').and(env.refStill).and(env.notOperable)),
      ],
      (out) => out.supported.not(),
    ),
    law(
      'an element inside a frame keeps the coordinate path',
      (env) => [env.known, env.mainFrame.not()],
      (out) => out.supported.not(),
    ),
  ];
}

const frameInputs = { main: Count, frame: Count, probeOk: bool };

/** locateInTree's matches as core sees them: frames included, never perceivable. */
export const frameRule = fun('frame-matches')
  .inputs(frameInputs)
  .returns(({ frame, probeOk }) => ({
    returnsFrame: frame.is('none').not(),
    framePerceivable: frame.is('none').and(frame.is('none').not()),
    mainPerceivable: probeOk,
  }));
/** Drops frame matches, so a look-alike in a frame cannot make a match ambiguous. */
export const frameDroppedRule = fun('frame-matches-dropped')
  .inputs(frameInputs)
  .returns(({ frame, probeOk }) => ({
    returnsFrame: frame.is('none').and(frame.is('none').not()),
    framePerceivable: frame.is('none').and(frame.is('none').not()),
    mainPerceivable: probeOk,
  }));
/** Trusts the probe inside frames. */
export const frameTrustedRule = fun('frame-matches-trusted')
  .inputs(frameInputs)
  .returns(({ frame, probeOk }) => ({
    returnsFrame: frame.is('none').not(),
    framePerceivable: frame.is('none').not().and(probeOk),
    mainPerceivable: probeOk,
  }));

export function frameLaws(rule: typeof frameRule) {
  return [
    rule.law(
      'frame matches are returned, so they count toward ambiguity',
      (env) => [env.frame.is('none').not()],
      (out) => out.returnsFrame,
    ),
    rule.law(
      'a frame match is never perceivable',
      () => [],
      (out) => out.framePerceivable.not(),
    ),
  ];
}
