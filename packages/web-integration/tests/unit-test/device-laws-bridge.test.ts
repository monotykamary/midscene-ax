/**
 * Hold the browser-harness device to its proven rules (tests/laws/device-laws.ts):
 * the real actOnRef, supportsRefOperation and locateInTree run on a device
 * built from its prototype with only the browser stubbed out (the guarded
 * perform, the snapshot, the perceivability probe and the guard's
 * observation), over every state of each rule's abstraction.
 */
import { BrowserHarnessPage } from '@/browser-harness';
import { guardOperationFor, harnessCallFor } from '@/browser-harness/receipt';
import type { HarnessRefEntry } from '@/browser-harness/tree';
import type { RefOperation, TreeMatch } from '@midscene/core';
import { describe, expect, it } from '@rstest/core';
import { frameRule, rebindRule, supportRule } from '../laws/device-laws';

const bools = [false, true] as const;
const counts = ['none', 'one', 'many'] as const;
const statuses = ['executed', 'stale', 'blocked', 'outcome_unknown'] as const;
const n = { none: 0, one: 1, many: 2 };
const run = (rule: { run: (input: never) => unknown }, input: object) =>
  rule.run(input as never) as Record<string, boolean | number>;

const ref = (i: number, frame = false) =>
  `${frame ? 'f1' : ''}sAAAAAAAAAAAA_1e${i}`;
const entry = (
  i: number,
  mainFrame = true,
  name = 'Save',
): HarnessRefEntry => ({
  ref: ref(i, !mainFrame),
  role: 'button',
  name,
  backendNodeId: 100 + i,
  frameId: mainFrame ? 'main' : 'child',
  sessionId: 'session',
  mainFrame,
});
const asMatch = (e: HarnessRefEntry): TreeMatch => ({
  ref: e.ref,
  rect: { left: 0, top: 0, width: 10, height: 10 },
  role: e.role,
  name: e.name,
  revision: 'r1',
});
/** A device whose browser-facing members are the given stubs. */
const device = (stubs: Record<string, unknown>) =>
  Object.assign(Object.create(BrowserHarnessPage.prototype), stubs) as any;

describe('actOnRef() rebinds a stale ref as the rebind rule says, on every state', () => {
  for (const first of statuses)
    for (const known of bools)
      for (const rebindErrored of bools)
        for (const candidates of counts)
          for (const perceivable of bools)
            for (const second of statuses) {
              const state = {
                first,
                known,
                rebindErrored,
                candidates,
                perceivable,
                second,
              };
              it(JSON.stringify(state), async () => {
                const original = entry(1);
                const lookAlikes = Array.from(
                  { length: n[candidates] },
                  (_, i) => entry(10 + i),
                );
                // A look-alike in a frame is never a rebind target.
                const inFrame = entry(20, false);
                const performed: string[] = [];
                const answers = [first, second];
                const d = device({
                  perform: async (target: string) => {
                    performed.push(target);
                    return { status: answers[performed.length - 1] ?? 'stale' };
                  },
                  entryFor: (r: string) =>
                    known && r === original.ref ? original : undefined,
                  currentSnapshot: async () => {
                    if (rebindErrored) throw new Error('snapshot failed');
                    return {
                      entries: new Map(
                        [...lookAlikes, inFrame].map((e) => [e.ref, e]),
                      ),
                    };
                  },
                  probe: async (entries: HarnessRefEntry[]) =>
                    new Map(
                      entries.map((e) => [
                        e.ref,
                        {
                          rect: { left: 0, top: 0, width: 10, height: 10 },
                          ok: perceivable,
                          ...(perceivable ? {} : { why: 'covered' }),
                        },
                      ]),
                    ),
                });
                const receipt = await d.actOnRef(asMatch(original), 'tap');
                const rule = run(rebindRule, state);
                expect({
                  state,
                  rebound: receipt.rebound !== undefined,
                  performs: performed.length,
                  finalStale: receipt.status === 'stale',
                }).toEqual({
                  state,
                  rebound: rule.rebound,
                  performs: rule.performs,
                  finalStale: rule.finalStale,
                });
              });
            }
});

describe('supportsRefOperation() agrees with the operation support rule on every state', () => {
  const operations = [
    'tap',
    'input',
    'clear',
    'keyboardPress',
    'select',
    'scrollIntoView',
    'hover',
    'doubleClick',
    'rightClick',
  ] as const;
  const offereds = ['needed', 'scrollOnly', 'other', 'none'] as const;
  for (const operation of operations)
    it(`on ${operation}`, async () => {
      for (const payload of bools)
        for (const keyAllowed of bools)
          for (const known of bools)
            for (const mainFrame of bools)
              for (const probeFailed of bools)
                for (const offered of offereds)
                  for (const refStill of bools)
                    for (const notOperable of bools) {
                      const state = {
                        operation,
                        payload,
                        keyAllowed,
                        known,
                        mainFrame,
                        probeFailed,
                        offered,
                        refStill,
                        notOperable,
                      };
                      {
                        const target = entry(1, mainFrame);
                        const text =
                          operation === 'keyboardPress'
                            ? keyAllowed
                              ? 'Enter'
                              : 'Control+A'
                            : 'value';
                        const value = payload ? text : undefined;
                        const call = harnessCallFor(
                          operation as RefOperation,
                          value,
                        );
                        const operations =
                          offered === 'needed'
                            ? [call ? guardOperationFor(call) : 'click']
                            : offered === 'scrollOnly'
                              ? ['scroll_into_view']
                              : ['__not_the_needed_operation__'];
                        const d = device({
                          entryFor: (r: string) =>
                            known && r === target.ref ? target : undefined,
                          page: {
                            scope: 'scope',
                            refs: new Map(refStill ? [[target.ref, {}]] : []),
                          },
                          operability: {
                            observe: async () => {
                              if (probeFailed) throw new Error('page changed');
                              return offered === 'none'
                                ? {
                                    candidates: [],
                                    refusal: notOperable
                                      ? 'not an operable control (input type=date)'
                                      : 'disabled; enable it first',
                                  }
                                : { candidates: [{ operations }] };
                            },
                            invalidate: () => {},
                          },
                        });
                        const supported = await d.supportsRefOperation(
                          asMatch(target),
                          operation,
                          value,
                        );
                        expect({ state, supported }).toEqual({
                          state,
                          supported: run(supportRule, state).supported,
                        });
                      }
                    }
    });
});

describe('locateInTree() reports frame matches as the frame rule says, on every state', () => {
  for (const main of counts)
    for (const frame of counts)
      for (const probeOk of bools) {
        const state = { main, frame, probeOk };
        it(JSON.stringify(state), async () => {
          const entries = [
            ...Array.from({ length: n[main] }, (_, i) => entry(i + 1)),
            ...Array.from({ length: n[frame] }, (_, i) => entry(i + 10, false)),
            entry(30, true, 'Cancel'),
          ];
          const d = device({
            currentSnapshot: async () => ({
              entries: new Map(entries.map((e) => [e.ref, e])),
              revision: 'r1',
            }),
            probe: async (found: HarnessRefEntry[]) =>
              new Map(
                found.map((e) => [
                  e.ref,
                  {
                    rect: { left: 0, top: 0, width: 10, height: 10 },
                    ok: probeOk,
                    ...(probeOk ? {} : { why: 'covered' }),
                  },
                ]),
              ),
          });
          const matches: TreeMatch[] = await d.locateInTree({
            name: 'Save',
            exact: true,
          });
          const inFrame = matches.filter((m) => m.ref.startsWith('f'));
          const inMain = matches.filter((m) => !m.ref.startsWith('f'));
          const rule = run(frameRule, state);
          expect({
            state,
            count: matches.length,
            returnsFrame: inFrame.length > 0,
            framePerceivable: inFrame.some((m) => m.perceivable?.perceivable),
            mainPerceivable:
              inMain.length > 0 &&
              inMain.every((m) => m.perceivable?.perceivable),
          }).toEqual({
            state,
            count: n[main] + n[frame],
            returnsFrame: rule.returnsFrame,
            framePerceivable: rule.framePerceivable,
            mainPerceivable: inMain.length > 0 && rule.mainPerceivable,
          });
        });
      }
});
