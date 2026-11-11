/**
 * Every browser-harness device law is proven, and every kept broken variant
 * is refuted on the laws it breaks (gdp-wired).
 */
import { describe, expect, it } from '@rstest/core';
import { proveDecision } from 'gdp-wired';
import {
  frameDroppedRule,
  frameLaws,
  frameRule,
  frameTrustedRule,
  rebindFirstRule,
  rebindHiddenRule,
  rebindLaws,
  rebindRule,
  rebindTwiceRule,
  rebindUnknownRule,
  supportAnyControlRule,
  supportAnyKeyRule,
  supportEverythingRule,
  supportHoverRule,
  supportLaws,
  supportRule,
} from '../laws/device-laws';

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

const HOVER = 'hover, double click and right click keep the coordinate path';
const CHORD =
  'a key the guard cannot press, such as a chord, keeps the coordinate path';
const CONTROL =
  'a control the guard does not operate, such as a date input or a slider, keeps the coordinate path';
const FRAME = 'an element inside a frame keeps the coordinate path';

describe('browser-harness device laws', () => {
  it('the rebind laws are proven', () => proven(rebindLaws(rebindRule)));
  it.each([
    [
      'rebinds again when the rebound element is stale',
      rebindTwiceRule,
      ['a stale ref is rebound at most once'],
    ],
    [
      'rebinds to the first of several look-alikes',
      rebindFirstRule,
      ['a rebind needs exactly one element with the same identity'],
    ],
    [
      'rebinds without checking the element is shown',
      rebindHiddenRule,
      ['a rebind needs that element to be perceivable'],
    ],
    [
      "rebinds a ref from another page's snapshots",
      rebindUnknownRule,
      ["a ref from another page's snapshots is never rebound"],
    ],
  ] as const)('a device that %s is refuted', (_label, rule, broken) =>
    refutes(rebindLaws(rule as typeof rebindRule), broken),
  );

  it('the operation support laws are proven', () =>
    proven(supportLaws(supportRule)));
  it.each([
    [
      'supports every operation',
      supportEverythingRule,
      [HOVER, CHORD, CONTROL, FRAME],
    ],
    ['hovers by ref', supportHoverRule, [HOVER]],
    ['presses any key by ref', supportAnyKeyRule, [CHORD]],
    [
      'trusts a control the guard does not offer the operation on',
      supportAnyControlRule,
      [CONTROL],
    ],
  ] as const)('a device that %s is refuted', (_label, rule, broken) =>
    refutes(supportLaws(rule as typeof supportRule), broken),
  );

  it('the frame laws are proven', () => proven(frameLaws(frameRule)));
  it.each([
    [
      'drops frame matches',
      frameDroppedRule,
      ['frame matches are returned, so they count toward ambiguity'],
    ],
    [
      'trusts the probe inside frames',
      frameTrustedRule,
      ['a frame match is never perceivable'],
    ],
  ] as const)('a device that %s is refuted', (_label, rule, broken) =>
    refutes(frameLaws(rule as typeof frameRule), broken),
  );
});
