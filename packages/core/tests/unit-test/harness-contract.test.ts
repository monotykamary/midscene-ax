import { TaskBuilder, locatePlanForLocate } from '@/agent/task-builder';
import type { TaskCache } from '@/agent/task-cache';
import {
  RefActionBlockedError,
  refOperationForAction,
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
  PlanningAction,
  RefOperation,
  TreeMatch,
  TreeQuery,
} from '@/types';
import { buildDetailedLocateParam } from '@/yaml/utils';
import { describe, expect, it, rs } from '@rstest/core';
import { z } from 'zod';

const runtime = getModelRuntime({
  modelName: 'mock-model',
  modelDescription: 'mock-model-description',
  intent: 'default',
  slot: 'default',
});

const loginMatch: TreeMatch = {
  ref: 'e12',
  rect: { left: 10, top: 20, width: 40, height: 10 },
  role: 'button',
  name: 'Log in',
  revision: 'r1',
};

// A device without the harness contract, as every device is today.
class PlainInterface extends AbstractInterface {
  interfaceType = 'plain';
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

// A device that implements the harness contract with scripted answers.
class HarnessInterface extends PlainInterface {
  matches: TreeMatch[] | Error = [loginMatch];
  perceivability?: Perceivability | Error;
  receipt: ActReceipt = { status: 'executed', verified: true };

  locateSpy = rs.fn(async (_query: TreeQuery, _signal?: AbortSignal) => {
    if (this.matches instanceof Error) throw this.matches;
    return this.matches;
  });

  actSpy = rs.fn(
    async (
      _match: TreeMatch,
      _operation: RefOperation,
      _payload?: string,
      _signal?: AbortSignal,
    ): Promise<ActReceipt> => this.receipt,
  );

  perceivableSpy = rs.fn(
    async (
      _match: TreeMatch,
      _signal?: AbortSignal,
    ): Promise<Perceivability> => {
      if (this.perceivability instanceof Error) throw this.perceivability;
      return this.perceivability ?? { perceivable: true };
    },
  );

  async locateInTree(query: TreeQuery, signal?: AbortSignal) {
    return this.locateSpy(query, signal);
  }

  async actOnRef(
    match: TreeMatch,
    operation: RefOperation,
    payload?: string,
    signal?: AbortSignal,
  ) {
    return this.actSpy(match, operation, payload, signal);
  }

  async perceivable(match: TreeMatch, signal?: AbortSignal) {
    return this.perceivableSpy(match, signal);
  }
}

const aiElement = {
  center: [300, 300] as [number, number],
  rect: { left: 290, top: 290, width: 20, height: 20 },
  description: 'from AI',
};

function makeService() {
  return {
    contextRetrieverFn: rs.fn(),
    locate: rs.fn(async () => ({ element: aiElement })),
  };
}

function makeTaskContext(ratio = 2) {
  return {
    task: { timing: {} } as Record<string, any>,
    uiContext: { shrunkShotToLogicalRatio: ratio, deprecatedDpr: 1 },
  };
}

async function runLocate(
  device: AbstractInterface,
  param: string | DetailedLocateParam,
  options: { taskCache?: TaskCache; ratio?: number } = {},
) {
  const service = makeService();
  const builder = new TaskBuilder({
    getDefaultModelRuntime: () => runtime,
    interfaceInstance: device,
    service: service as unknown as Service,
    taskCache: options.taskCache,
    actionSpace: [],
  });
  const { tasks } = await builder.build(
    [locatePlanForLocate(param)],
    runtime,
    runtime,
  );
  const context = makeTaskContext(options.ratio);
  const result: any = await tasks[0].executor(context as any);
  return { result, task: context.task, service };
}

describe('harness contract: tree rung of the locate chain', () => {
  it('locates a unique perceivable match from the tree without AI', async () => {
    const device = new HarnessInterface();
    const { result, task, service } = await runLocate(device, 'Log in');

    expect(device.locateSpy).toHaveBeenCalledWith(
      { name: 'Log in', exact: true },
      undefined,
    );
    expect(service.locate).not.toHaveBeenCalled();
    // logical rect center (30, 25) scaled by shrunkShotToLogicalRatio = 2
    expect(result.output.element).toMatchObject({
      center: [60, 50],
      rect: { left: 20, top: 40, width: 80, height: 20 },
      nodeRef: 'e12',
      treeRevision: 'r1',
      description: 'Log in',
    });
    expect(result.hitBy).toEqual({
      from: 'Accessibility tree',
      context: {
        query: { name: 'Log in', exact: true },
        ref: 'e12',
        role: 'button',
        name: 'Log in',
        revision: 'r1',
      },
    });
    expect(task.treeLocate).toEqual({
      query: { name: 'Log in', exact: true },
      outcome: 'hit',
      matchCount: 1,
      ref: 'e12',
      revision: 'r1',
    });
  });

  it('lets a plan direct hit win over the tree', async () => {
    const device = new HarnessInterface();
    const { result, service } = await runLocate(device, {
      prompt: 'Log in',
      locatedPixelResult: { center: [20, 20] },
    } as any);

    expect(device.locateSpy).not.toHaveBeenCalled();
    expect(service.locate).not.toHaveBeenCalled();
    expect(result.output.element.center).toEqual([20, 20]);
    expect(result.hitBy.from).toBe('Plan');
  });

  it('lets an xpath hit win over the tree', async () => {
    const device = new HarnessInterface();
    device.rectMatchesCacheFeature = rs.fn(async () => ({
      left: 0,
      top: 0,
      width: 10,
      height: 10,
    }));
    const { result, task } = await runLocate(device, {
      prompt: 'Log in',
      xpath: '//button',
    });

    expect(device.locateSpy).not.toHaveBeenCalled();
    expect(result.hitBy.from).toBe('User expected path');
    expect(result.output.element.nodeRef).toBeUndefined();
    expect(task.treeLocate).toBeUndefined();
  });

  it('beats the cache and does not write the locate cache', async () => {
    const device = new HarnessInterface();
    device.rectMatchesCacheFeature = rs.fn(async () => ({
      left: 0,
      top: 0,
      width: 10,
      height: 10,
    }));
    device.cacheFeatureForPoint = rs.fn(async () => ({ xpaths: ['//b'] }));
    const taskCache = {
      isCacheResultUsed: true,
      matchLocateCache: rs.fn(() => ({
        cacheContent: { cache: { xpaths: ['//a'] } },
      })),
      updateOrAppendCacheRecord: rs.fn(),
    } as unknown as TaskCache;

    const { result, service } = await runLocate(device, 'Log in', {
      taskCache,
    });

    expect(result.hitBy.from).toBe('Accessibility tree');
    expect(device.rectMatchesCacheFeature).not.toHaveBeenCalled();
    expect(service.locate).not.toHaveBeenCalled();
    expect(device.cacheFeatureForPoint).not.toHaveBeenCalled();
    expect(taskCache.updateOrAppendCacheRecord).not.toHaveBeenCalled();
  });

  it('falls through to the cache when the tree abstains', async () => {
    const device = new HarnessInterface();
    device.matches = [];
    device.rectMatchesCacheFeature = rs.fn(async () => ({
      left: 0,
      top: 0,
      width: 10,
      height: 10,
    }));
    const taskCache = {
      isCacheResultUsed: true,
      matchLocateCache: rs.fn(() => ({
        cacheContent: { cache: { xpaths: ['//a'] } },
      })),
      updateOrAppendCacheRecord: rs.fn(),
    } as unknown as TaskCache;

    const { result, task, service } = await runLocate(device, 'Log in', {
      taskCache,
    });

    expect(result.hitBy.from).toBe('Cache');
    expect(service.locate).not.toHaveBeenCalled();
    expect(task.treeLocate.outcome).toBe('abstained');
  });

  it.each([
    {
      name: 'no match',
      setup: (d: HarnessInterface) => {
        d.matches = [];
      },
      reason: 'no element matched',
      matchCount: 0,
    },
    {
      name: 'several matches',
      setup: (d: HarnessInterface) => {
        d.matches = [loginMatch, { ...loginMatch, ref: 'e13' }];
      },
      reason: 'ambiguous: 2 elements matched',
      matchCount: 2,
    },
    {
      name: 'match reports it is not perceivable',
      setup: (d: HarnessInterface) => {
        d.matches = [
          {
            ...loginMatch,
            perceivable: { perceivable: false, why: 'covered by div.modal' },
          },
        ];
      },
      reason: 'not perceivable: covered by div.modal',
      matchCount: 1,
    },
    {
      name: 'perceivable() says hidden',
      setup: (d: HarnessInterface) => {
        d.perceivability = {
          perceivable: false,
          why: 'opacity 0 on ancestor form',
        };
      },
      reason: 'not perceivable: opacity 0 on ancestor form',
      matchCount: 1,
    },
    {
      name: 'perceivable() throws',
      setup: (d: HarnessInterface) => {
        d.perceivability = new Error('hit test failed');
      },
      reason: 'perceivability check failed: hit test failed',
      matchCount: 1,
    },
    {
      name: 'locateInTree throws',
      setup: (d: HarnessInterface) => {
        d.matches = new Error('tree unavailable');
      },
      reason: 'locateInTree failed: tree unavailable',
      matchCount: undefined,
    },
  ])(
    'abstains and falls back to AI when $name',
    async ({ setup, reason, matchCount }) => {
      const device = new HarnessInterface();
      setup(device);
      const { result, task, service } = await runLocate(device, 'Log in');

      expect(service.locate).toHaveBeenCalledTimes(1);
      expect(result.output.element.center).toEqual(aiElement.center);
      expect(result.output.element.nodeRef).toBeUndefined();
      expect(result.hitBy).toBeUndefined();
      expect(task.treeLocate).toEqual({
        query: { name: 'Log in', exact: true },
        outcome: 'abstained',
        reason,
        ...(matchCount !== undefined ? { matchCount } : {}),
      });
    },
  );

  it('uses the match perceivability without asking the device again', async () => {
    const device = new HarnessInterface();
    device.matches = [{ ...loginMatch, perceivable: { perceivable: true } }];
    const { result } = await runLocate(device, 'Log in');

    expect(device.perceivableSpy).not.toHaveBeenCalled();
    expect(result.hitBy.from).toBe('Accessibility tree');
  });

  it('addresses an explicit tree ref', async () => {
    const device = new HarnessInterface();
    const { result, service } = await runLocate(device, {
      prompt: 'the sign-in button',
      tree: { ref: 'e12' },
    });

    expect(device.locateSpy).toHaveBeenCalledWith({ ref: 'e12' }, undefined);
    expect(service.locate).not.toHaveBeenCalled();
    expect(result.output.element.nodeRef).toBe('e12');
    expect(result.output.element.description).toBe('the sign-in button');
  });

  it('addresses an explicit role and name', async () => {
    const device = new HarnessInterface();
    const tree = { role: 'button', name: 'Log in', context: 'Sign in dialog' };
    const { result } = await runLocate(device, {
      prompt: 'the sign-in button',
      tree,
    });

    expect(device.locateSpy).toHaveBeenCalledWith(tree, undefined);
    expect(result.hitBy.context.query).toEqual(tree);
  });

  it('locates a tree-only address and reports why it failed', async () => {
    const device = new HarnessInterface();
    const { result } = await runLocate(device, {
      tree: { ref: 'e12' },
    } as DetailedLocateParam);
    expect(result.output.element.nodeRef).toBe('e12');

    device.matches = [];
    await expect(
      runLocate(device, { tree: { ref: 'e99' } } as DetailedLocateParam),
    ).rejects.toThrow(/accessibility tree: no element matched/);
  });

  it('normalises whitespace in a plain-string prompt to an exact name', async () => {
    const device = new HarnessInterface();
    await runLocate(device, '  Log \n  in ');
    expect(device.locateSpy).toHaveBeenCalledWith(
      { name: 'Log in', exact: true },
      undefined,
    );
  });

  it('never queries loosely from a free-form sentence', async () => {
    const device = new HarnessInterface();
    // A sloppy device answers with the button whose name appears in the
    // sentence; core still requires the whole name to match exactly.
    device.matches = [{ ...loginMatch, name: 'Submit' }];
    const sentence = 'the "Submit" button at the bottom of the form';
    const { task, service } = await runLocate(device, sentence);

    expect(device.locateSpy).toHaveBeenCalledTimes(1);
    expect(device.locateSpy).toHaveBeenCalledWith(
      { name: sentence, exact: true },
      undefined,
    );
    expect(service.locate).toHaveBeenCalledTimes(1);
    expect(task.treeLocate.reason).toBe('no element matched');
  });

  it('does not query the tree for prompts with images or per-call context', () => {
    expect(
      treeQueryForLocate({
        prompt: {
          prompt: 'Log in',
          images: [{ name: 'ref', url: 'https://example.com/a.png' }],
        },
      }),
    ).toBeUndefined();
    expect(
      treeQueryForLocate({
        prompt: '<CONTEXT>c</CONTEXT><LOCATE_TARGET>Log in</LOCATE_TARGET>',
        promptDisplay: 'Log in',
        context: 'c',
      }),
    ).toBeUndefined();
    expect(treeQueryForLocate({ prompt: '   ' })).toBeUndefined();
  });

  it('leaves a device without the contract unchanged', async () => {
    const device = new PlainInterface();
    const { result, task, service } = await runLocate(device, 'Log in');

    expect(service.locate).toHaveBeenCalledWith(
      { prompt: 'Log in' },
      expect.any(Object),
      runtime,
      undefined,
    );
    expect(result.output.element).toEqual({ ...aiElement, dpr: 1 });
    expect(result.hitBy).toBeUndefined();
    expect(task.treeLocate).toBeUndefined();
  });

  it('carries the tree option through buildDetailedLocateParam', () => {
    expect(
      buildDetailedLocateParam('Log in', { tree: { ref: 'e12' } }),
    ).toMatchObject({ prompt: 'Log in', tree: { ref: 'e12' } });
    expect(buildDetailedLocateParam('Log in', {})).not.toHaveProperty('tree');
  });
});

describe('harness contract: acting on refs', () => {
  const locateSchema = getMidsceneLocationSchema();

  function action(
    name: string,
    paramSchema: z.ZodType,
  ): DeviceAction & { call: ReturnType<typeof rs.fn> } {
    return {
      name,
      description: name,
      paramSchema,
      delayBeforeRunner: 0,
      delayAfterRunner: 0,
      call: rs.fn(async () => undefined),
    } as any;
  }

  const tap = () => action('Tap', z.object({ locate: locateSchema }));
  const input = () =>
    action(
      'Input',
      z.object({
        value: z.string().optional(),
        locate: locateSchema.optional(),
        mode: z.enum(['replace', 'clear', 'typeOnly']).default('replace'),
      }),
    );
  const keyboardPress = () =>
    action(
      'KeyboardPress',
      z.object({ locate: locateSchema.optional(), keyName: z.string() }),
    );

  async function runPlan(
    device: AbstractInterface,
    deviceAction: DeviceAction,
    plan: PlanningAction,
  ) {
    const builder = new TaskBuilder({
      getDefaultModelRuntime: () => runtime,
      interfaceInstance: device,
      service: makeService() as unknown as Service,
      actionSpace: [deviceAction],
    });
    const { tasks } = await builder.build([plan], runtime, runtime);
    expect(tasks.map((task) => task.subType)).toEqual([
      'Locate',
      deviceAction.name,
    ]);
    await tasks[0].executor(makeTaskContext() as any);
    const actionContext = makeTaskContext();
    const run = tasks[1].executor(actionContext as any);
    return { run, task: actionContext.task };
  }

  // The locate task writes the located element back into the plan, so each
  // test gets a fresh plan.
  const tapPlan = (): PlanningAction => ({
    type: 'Tap',
    thought: '',
    param: { locate: { prompt: 'Log in' } },
  });

  it('acts on the ref when the receipt is executed', async () => {
    const device = new HarnessInterface();
    device.receipt = {
      status: 'executed',
      verified: true,
      diff: 'dialog closed',
      revision: 'r2',
    };
    const tapAction = tap();
    const { run, task } = await runPlan(device, tapAction, tapPlan());
    await expect(run).resolves.toEqual({ output: undefined });

    expect(device.actSpy).toHaveBeenCalledTimes(1);
    expect(device.actSpy).toHaveBeenCalledWith(
      loginMatch,
      'tap',
      undefined,
      undefined,
    );
    expect(tapAction.call).not.toHaveBeenCalled();
    expect(task.receipt).toEqual(device.receipt);
    expect(task.refAct).toEqual({ ref: 'e12', operation: 'tap' });
  });

  it('falls back once to coordinates when the ref is stale', async () => {
    const device = new HarnessInterface();
    device.receipt = { status: 'stale', verified: null, reason: 'detached' };
    const tapAction = tap();
    const { run, task } = await runPlan(device, tapAction, tapPlan());
    await run;

    expect(device.actSpy).toHaveBeenCalledTimes(1);
    expect(tapAction.call).toHaveBeenCalledTimes(1);
    // parseActionParam maps the screenshot center back to logical (30, 25)
    expect(tapAction.call.mock.calls[0][0].locate.center).toEqual([30, 25]);
    expect(task.receipt.status).toBe('stale');
    expect(task.refAct).toEqual({
      ref: 'e12',
      operation: 'tap',
      fallback: 'coordinates',
    });
  });

  it('acts at coordinates without calling actOnRef when the interface declines the operation', async () => {
    const device = new HarnessInterface() as HarnessInterface & {
      supportsRefOperation: AbstractInterface['supportsRefOperation'];
    };
    const supportsSpy = rs.fn(async () => false);
    device.supportsRefOperation = supportsSpy;
    const tapAction = tap();
    const { run, task } = await runPlan(device, tapAction, tapPlan());
    await run;

    expect(supportsSpy).toHaveBeenCalledWith(
      loginMatch,
      'tap',
      undefined,
      undefined,
    );
    expect(device.actSpy).not.toHaveBeenCalled();
    expect(tapAction.call).toHaveBeenCalledTimes(1);
    expect(tapAction.call.mock.calls[0][0].locate.center).toEqual([30, 25]);
    expect(task.receipt).toBeUndefined();
    expect(task.refAct).toEqual({
      ref: 'e12',
      operation: 'tap',
      fallback: 'coordinates',
      declined: true,
    });
  });

  it('acts on the ref when the interface supports the operation', async () => {
    const device = new HarnessInterface() as HarnessInterface & {
      supportsRefOperation: AbstractInterface['supportsRefOperation'];
    };
    device.supportsRefOperation = rs.fn(async () => true);
    const tapAction = tap();
    const { run, task } = await runPlan(device, tapAction, tapPlan());
    await run;

    expect(device.actSpy).toHaveBeenCalledTimes(1);
    expect(tapAction.call).not.toHaveBeenCalled();
    expect(task.refAct).toEqual({ ref: 'e12', operation: 'tap' });
  });

  it('throws with the reason when the action is blocked', async () => {
    const device = new HarnessInterface();
    device.receipt = {
      status: 'blocked',
      verified: null,
      reason: 'covered by div.cookie-banner',
    };
    const tapAction = tap();
    const { run, task } = await runPlan(device, tapAction, tapPlan());

    await expect(run).rejects.toThrow(
      'Tap was blocked on element e12: covered by div.cookie-banner',
    );
    const error = await Promise.resolve(run).catch((e) => e);
    expect(error).toBeInstanceOf(RefActionBlockedError);
    expect(error.receipt).toEqual(device.receipt);
    expect(tapAction.call).not.toHaveBeenCalled();
    expect(task.receipt.status).toBe('blocked');
  });

  it('records an unknown outcome without claiming verification', async () => {
    const device = new HarnessInterface();
    device.receipt = {
      status: 'outcome_unknown',
      verified: true,
      reason: 'no change observed',
    };
    const tapAction = tap();
    const { run, task } = await runPlan(device, tapAction, tapPlan());
    await run;

    expect(tapAction.call).not.toHaveBeenCalled();
    expect(task.receipt).toEqual({
      status: 'outcome_unknown',
      verified: null,
      reason: 'no change observed',
    });
    expect(task.planningFeedback).toContain('outcome is unknown');
  });

  it('maps Input and KeyboardPress to ref operations with a payload', async () => {
    const device = new HarnessInterface();
    const inputAction = input();
    await (
      await runPlan(device, inputAction, {
        type: 'Input',
        thought: '',
        param: { value: 'alice', locate: { prompt: 'Log in' } },
      })
    ).run;
    expect(device.actSpy).toHaveBeenLastCalledWith(
      loginMatch,
      'input',
      'alice',
      undefined,
    );

    const pressAction = keyboardPress();
    await (
      await runPlan(device, pressAction, {
        type: 'KeyboardPress',
        thought: '',
        param: { keyName: 'Enter', locate: { prompt: 'Log in' } },
      })
    ).run;
    expect(device.actSpy).toHaveBeenLastCalledWith(
      loginMatch,
      'keyboardPress',
      'Enter',
      undefined,
    );
    expect(inputAction.call).not.toHaveBeenCalled();
    expect(pressAction.call).not.toHaveBeenCalled();
  });

  it('keeps unmapped variants on the coordinate path', async () => {
    const device = new HarnessInterface();
    const inputAction = input();
    const { run, task } = await runPlan(device, inputAction, {
      type: 'Input',
      thought: '',
      param: { value: 'x', mode: 'typeOnly', locate: { prompt: 'Log in' } },
    });
    await run;

    expect(device.actSpy).not.toHaveBeenCalled();
    expect(inputAction.call).toHaveBeenCalledTimes(1);
    expect(task.receipt).toBeUndefined();
    expect(refOperationForAction('DragAndDrop', {})).toBeUndefined();
    expect(refOperationForAction('Input', { mode: 'clear' })).toEqual({
      operation: 'clear',
    });
  });

  it('uses coordinates for an AI-located element', async () => {
    const device = new HarnessInterface();
    device.matches = [];
    const tapAction = tap();
    const { run } = await runPlan(device, tapAction, tapPlan());
    await run;

    expect(device.actSpy).not.toHaveBeenCalled();
    expect(tapAction.call).toHaveBeenCalledTimes(1);
  });

  it('uses coordinates when the device cannot act on refs', async () => {
    const device = new PlainInterface();
    const tapAction = tap();
    const { run, task } = await runPlan(device, tapAction, {
      type: 'Tap',
      thought: '',
      param: {
        locate: {
          prompt: 'Log in',
          locatedPixelResult: { center: [60, 50] },
        },
      },
    });
    await run;

    expect(tapAction.call).toHaveBeenCalledTimes(1);
    expect(task.receipt).toBeUndefined();
    expect(task.refAct).toBeUndefined();
  });
});
