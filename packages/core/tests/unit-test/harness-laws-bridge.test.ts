/**
 * Hold the shipped harness-contract code to the proven rules
 * (tests/laws/harness-laws.ts): every state of each rule's abstraction is
 * built as concrete input, the real function runs, and its answer must equal
 * the rule's. Exhaustive over the abstraction, not sampled.
 */
import { TaskBuilder, locatePlanForLocate } from '@/agent/task-builder';
import type { TaskCache } from '@/agent/task-cache';
import {
  LOCATE_RUNGS,
  type LocateRung,
  RefActionBlockedError,
  TREE_HIT_SOURCE,
  locateCacheWritable,
  locateRungRuns,
  locateSource,
  receiptOutcome,
  resolveTreeLocate,
  treeQueryForLocate,
} from '@/agent/tree-locate';
import { getMidsceneLocationSchema } from '@/ai-model';
import { getModelRuntime } from '@/ai-model/models';
import { AbstractInterface } from '@/device';
import type Service from '@/service';
import type {
  ActReceipt,
  DetailedLocateParam,
  DeviceAction,
  Perceivability,
  RefOperation,
  TreeMatch,
  TreeQuery,
} from '@/types';
import { describe, expect, it, rs } from '@rstest/core';
import { z } from 'zod';
import {
  cacheWriteRule,
  locateChainRule,
  receiptRule,
  treeQueryRule,
  treeRungRule,
} from '../laws/harness-laws';

const bools = [false, true] as const;
const counts = ['none', 'one', 'many'] as const;
const run = (rule: { run: (input: never) => unknown }, input: object) =>
  rule.run(input as never) as Record<string, boolean | number>;

const runtime = getModelRuntime({
  modelName: 'mock-model',
  modelDescription: 'mock-model-description',
  intent: 'default',
  slot: 'default',
});

class Device extends AbstractInterface {
  interfaceType = 'bridge';
  override cacheFeatureForPoint: AbstractInterface['cacheFeatureForPoint'] =
    undefined;
  override rectMatchesCacheFeature: AbstractInterface['rectMatchesCacheFeature'] =
    undefined;
  override destroy: AbstractInterface['destroy'] = undefined;
  override describe: AbstractInterface['describe'] = undefined;
  override beforeInvokeAction: AbstractInterface['beforeInvokeAction'] =
    undefined;
  override afterInvokeAction: AbstractInterface['afterInvokeAction'] =
    undefined;
  override getUITree: AbstractInterface['getUITree'] = undefined;
  override getElementsNodeTree: AbstractInterface['getElementsNodeTree'] =
    undefined;
  override url: AbstractInterface['url'] = undefined;
  override evaluateJavaScript: AbstractInterface['evaluateJavaScript'] =
    undefined;
  constructor(private readonly actions: DeviceAction[] = []) {
    super();
  }
  async screenshotBase64(): Promise<string> {
    return 'mock';
  }
  async size(): Promise<{ width: number; height: number }> {
    return { width: 0, height: 0 };
  }
  actionSpace(): DeviceAction[] {
    return this.actions;
  }
}

const NAME = 'Log in';
const match = (ref: string, name: string): TreeMatch => ({
  ref,
  rect: { left: 10, top: 20, width: 40, height: 10 },
  role: 'button',
  name,
  revision: 'r1',
});

describe('resolveTreeLocate() agrees with the tree rung rule on every state', () => {
  const seens = ['yes', 'no', 'unchecked'] as const;
  for (const errored of bools)
    for (const exact of bools)
      for (const equal of counts)
        for (const other of counts)
          for (const seen of seens) {
            const state = { errored, exact, equal, other, seen };
            it(JSON.stringify(state), async () => {
              const n = { none: 0, one: 1, many: 2 };
              const matches = [
                ...Array.from({ length: n[equal] }, (_, i) =>
                  match(`e${i}`, NAME),
                ),
                ...Array.from({ length: n[other] }, (_, i) =>
                  match(`o${i}`, `${NAME} now`),
                ),
              ];
              const device = new Device() as Device & Record<string, unknown>;
              device.locateInTree = async () => {
                if (errored) throw new Error('tree unavailable');
                return matches;
              };
              if (seen !== 'unchecked')
                device.perceivable = async (): Promise<Perceivability> => ({
                  perceivable: seen === 'yes',
                  ...(seen === 'no' ? { why: 'covered' } : {}),
                });
              const query: TreeQuery = { name: NAME, exact };
              const outcome = await resolveTreeLocate(device, query);
              expect(outcome.record.outcome === 'hit').toBe(
                run(treeRungRule, state).hit,
              );
              if (outcome.record.outcome === 'abstained')
                expect(outcome.record.reason).toBeTruthy();
            });
          }
});

it('treeQueryForLocate() agrees with the tree query rule on every state', () => {
  for (const explicit of bools)
    for (const textPrompt of bools)
      for (const context of bools)
        for (const blank of bools) {
          const param: DetailedLocateParam = {
            prompt: textPrompt
              ? blank
                ? '   '
                : `  ${NAME}  `
              : { prompt: NAME, images: [{ name: 'logo', url: 'x' }] },
            ...(context ? { context: 'the login form' } : {}),
            ...(explicit ? { tree: { role: 'button', name: NAME } } : {}),
          } as DetailedLocateParam;
          const query = treeQueryForLocate(param);
          const rule = run(treeQueryRule, {
            explicit,
            textPrompt,
            context,
            blank,
          });
          const state = { explicit, textPrompt, context, blank };
          expect({ state, queried: query !== undefined }).toEqual({
            state,
            queried: rule.queried,
          });
          const derived = query !== undefined && !explicit;
          expect({ state, derived }).toEqual({ state, derived: rule.derived });
          if (derived)
            expect({ state, query }).toEqual({
              state,
              query: { name: NAME, exact: true },
            });
        }
});

it('locateRungRuns() and locateSource() agree with the locate chain rule on every state', () => {
  for (const plan of bools)
    for (const xpath of bools)
      for (const tree of bools)
        for (const cache of bools) {
          const state = { plan, xpath, tree, cache };
          const rule = run(locateChainRule, state);
          const hits = { plan, xpath, tree, cache };
          expect({
            state,
            xpath: locateRungRuns('xpath', { plan }),
            tree: locateRungRuns('tree', { plan, xpath }),
            cache: locateRungRuns('cache', { plan, xpath, tree }),
            ai: locateRungRuns('ai', hits),
            source: locateSource(hits),
          }).toEqual({
            state,
            xpath: rule.runsXpath,
            tree: rule.runsTree,
            cache: rule.runsCache,
            ai: rule.runsAi,
            source: LOCATE_RUNGS.find(
              (rung) =>
                rule[`from${rung[0].toUpperCase()}${rung.slice(1)}`] === true,
            ),
          });
        }
});

it('locateCacheWritable() agrees with the cache write rule on every state', () => {
  const cacheables = { unset: undefined, yes: true, no: false } as const;
  for (const found of bools)
    for (const cacheEnabled of bools)
      for (const source of LOCATE_RUNGS)
        for (const cacheExists of bools)
          for (const [cacheable, value] of Object.entries(cacheables)) {
            const state = {
              found,
              cacheEnabled,
              source,
              cacheExists,
              cacheable,
            };
            expect({
              state,
              write: locateCacheWritable({
                found,
                cacheEnabled,
                source,
                cacheExists,
                cacheable: value,
              }),
            }).toEqual({ state, write: run(cacheWriteRule, state).write });
          }
});

const statuses = ['executed', 'stale', 'blocked', 'outcome_unknown'] as const;
const verifieds = { yes: true, no: false, unknown: null } as const;
const receiptStates = statuses.flatMap((status) =>
  Object.keys(verifieds).flatMap((verified) =>
    bools.flatMap((reason) =>
      bools.map((diff) => ({ status, verified, reason, diff })),
    ),
  ),
) as Array<{
  status: (typeof statuses)[number];
  verified: keyof typeof verifieds;
  reason: boolean;
  diff: boolean;
}>;
const receiptFor = (state: (typeof receiptStates)[number]): ActReceipt => ({
  status: state.status,
  verified: verifieds[state.verified],
  ...(state.reason ? { reason: 'covered by the cookie banner' } : {}),
  ...(state.diff ? { diff: 'dialog closed' } : {}),
});

it('receiptOutcome() agrees with the receipt rule on every state', () => {
  for (const state of receiptStates) {
    const receipt = receiptFor(state);
    const outcome = receiptOutcome(receipt)!;
    const rule = run(receiptRule, state);
    expect({
      state,
      coordinates: outcome.path === 'coordinates',
      throws: outcome.path === 'throw',
      verifiedYes: outcome.receipt.verified === true,
      reasonKept: state.reason && outcome.receipt.reason === receipt.reason,
      diffKept: state.diff && outcome.receipt.diff === receipt.diff,
    }).toEqual({
      state,
      coordinates: rule.coordinates,
      throws: rule.throws,
      verifiedYes: rule.verifiedYes,
      reasonKept: rule.reasonKept,
      diffKept: rule.diffKept,
    });
  }
});

describe('the task builder acts on every receipt as the receipt rule says', () => {
  const locateSchema = getMidsceneLocationSchema();
  for (const state of receiptStates)
    it(JSON.stringify(state), async () => {
      const receipt = receiptFor(state);
      const tap = {
        name: 'Tap',
        description: 'Tap',
        paramSchema: z.object({ locate: locateSchema }),
        delayBeforeRunner: 0,
        delayAfterRunner: 0,
        call: rs.fn(async () => undefined),
      } as unknown as DeviceAction & { call: ReturnType<typeof rs.fn> };
      const device = new Device([tap]) as Device & Record<string, unknown>;
      const login = match('e12', NAME);
      device.locateInTree = async () => [login];
      const actOnRef = rs.fn(
        async (
          _match: TreeMatch,
          _operation: RefOperation,
        ): Promise<ActReceipt> => receipt,
      );
      device.actOnRef = actOnRef;
      const builder = new TaskBuilder({
        getDefaultModelRuntime: () => runtime,
        interfaceInstance: device,
        service: {
          contextRetrieverFn: rs.fn(),
          locate: rs.fn(async () => {
            throw new Error('AI locate must not run: the tree hits');
          }),
        } as unknown as Service,
        actionSpace: [tap],
      });
      const { tasks } = await builder.build(
        [{ type: 'Tap', thought: '', param: { locate: { prompt: NAME } } }],
        runtime,
        runtime,
      );
      const context = () => ({
        task: { timing: {} } as Record<string, any>,
        uiContext: { shrunkShotToLogicalRatio: 1, deprecatedDpr: 1 },
      });
      await tasks[0].executor(context() as any);
      const actionContext = context();
      const rule = run(receiptRule, state);
      let thrown: unknown;
      try {
        await tasks[1].executor(actionContext as any);
      } catch (error) {
        thrown = error;
      }
      const recorded = actionContext.task.receipt as ActReceipt;
      expect({
        state,
        refCalls: actOnRef.mock.calls.length,
        coordinateCalls: tap.call.mock.calls.length,
        throws: thrown instanceof RefActionBlockedError,
        reasonInError:
          state.reason &&
          thrown instanceof Error &&
          thrown.message.includes(receipt.reason!),
        verifiedYes: recorded.verified === true,
        diffKept: state.diff && recorded.diff === receipt.diff,
      }).toEqual({
        state,
        refCalls: 1,
        coordinateCalls: rule.coordinateCalls,
        throws: rule.throws,
        reasonInError: rule.throws && rule.reasonKept,
        verifiedYes: rule.verifiedYes,
        diffKept: rule.diffKept,
      });
    });
});

describe('the task builder walks the locate chain and writes the cache as the rules say', () => {
  const HIT_BY: Record<LocateRung, string | undefined> = {
    plan: 'Plan',
    xpath: 'User expected path',
    tree: TREE_HIT_SOURCE,
    cache: 'Cache',
    ai: undefined,
  };
  for (const plan of bools)
    for (const xpath of bools)
      for (const tree of bools)
        for (const cache of bools) {
          const state = { plan, xpath, tree, cache };
          it(JSON.stringify(state), async () => {
            const rect = { left: 0, top: 0, width: 10, height: 10 };
            const ran = { xpath: 0, tree: 0, cache: 0, ai: 0 };
            const device = new Device() as Device & Record<string, unknown>;
            device.rectMatchesCacheFeature = async (feature: {
              xpaths?: string[];
            }) => {
              const xpathAsked = feature.xpaths?.[0] === '//expected';
              if (xpathAsked) ran.xpath++;
              else ran.cache++;
              if ((xpathAsked && xpath) || (!xpathAsked && cache)) return rect;
              throw new Error('no element for the feature');
            };
            device.cacheFeatureForPoint = async () => ({
              xpaths: ['//written'],
            });
            device.locateInTree = async () => {
              ran.tree++;
              return tree ? [match('e12', NAME)] : [];
            };
            const updateOrAppendCacheRecord = rs.fn();
            const taskCache = {
              isCacheResultUsed: true,
              matchLocateCache: rs.fn(() =>
                cache
                  ? { cacheContent: { cache: { xpaths: ['//cached'] } } }
                  : undefined,
              ),
              updateOrAppendCacheRecord,
            } as unknown as TaskCache;
            const service = {
              contextRetrieverFn: rs.fn(),
              locate: rs.fn(async () => {
                ran.ai++;
                return {
                  element: {
                    center: [300, 300],
                    rect,
                    description: 'from AI',
                  },
                };
              }),
            };
            const builder = new TaskBuilder({
              getDefaultModelRuntime: () => runtime,
              interfaceInstance: device,
              service: service as unknown as Service,
              taskCache,
              actionSpace: [],
            });
            const param = {
              prompt: NAME,
              xpath: '//expected',
              ...(plan ? { locatedPixelResult: { center: [5, 5], rect } } : {}),
            } as DetailedLocateParam;
            const { tasks } = await builder.build(
              [locatePlanForLocate(param)],
              runtime,
              runtime,
            );
            const result: any = await tasks[0].executor({
              task: { timing: {} },
              uiContext: { shrunkShotToLogicalRatio: 1, deprecatedDpr: 1 },
            } as any);
            const chain = run(locateChainRule, state);
            const source = LOCATE_RUNGS.find(
              (rung) =>
                chain[`from${rung[0].toUpperCase()}${rung.slice(1)}`] === true,
            )!;
            const write = run(cacheWriteRule, {
              found: true,
              cacheEnabled: true,
              source,
              cacheExists: cache,
              cacheable: 'unset',
            }).write;
            expect({
              state,
              xpathRan: ran.xpath > 0,
              treeRan: ran.tree > 0,
              cacheRan: ran.cache > 0,
              aiRan: ran.ai > 0,
              hitBy: result.hitBy?.from,
              cacheWritten: updateOrAppendCacheRecord.mock.calls.length > 0,
            }).toEqual({
              state,
              xpathRan: chain.runsXpath,
              treeRan: chain.runsTree,
              // The cache rung asks the interface only when an entry exists.
              cacheRan: chain.runsCache && cache,
              aiRan: chain.runsAi,
              hitBy: HIT_BY[source],
              cacheWritten: write,
            });
          });
        }
});
