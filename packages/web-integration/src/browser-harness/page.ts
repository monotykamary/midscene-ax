import type {
  ActReceipt,
  Perceivability,
  Point,
  Rect,
  RefOperation,
  Size,
  TreeMatch,
  TreeQuery,
  UITreeSnapshot,
  UiNode,
} from '@midscene/core';
import type { DeviceAction, TextInputOptions } from '@midscene/core/device';
import { sleep } from '@midscene/core/utils';
import type { ElementInfo } from '@midscene/shared/extractor';
import { createImgBase64ByFormat } from '@midscene/shared/img';
import { getDebug } from '@midscene/shared/logger';
import { CdpKeyboard } from '../chrome-extension/cdpInput';
import { selectAllInputScript } from '../common/input-scripts';
import {
  AbstractWebPage,
  type KeyInput,
  type MouseButton,
  commonWebActionsForWebPage,
} from '../web-page';
import {
  FRAME_OFFSET_FUNCTION,
  MUTATION_COUNTER_EXPRESSION,
  PERCEIVABILITY_FUNCTION,
  type PerceivabilityProbe,
} from './perceivability';
import {
  type HarnessActionResult,
  type HarnessLocatorCall,
  guardOperationFor,
  harnessCallFor,
  toActReceipt,
} from './receipt';
import {
  type HarnessRefEntry,
  fieldEditability,
  matchEntries,
  normalizeName,
  parseSnapshotTree,
} from './tree';
import { Browser, type Page } from './vendor/bhjs/browser';
import { InteractionController } from './vendor/bhjs/interaction';
import type { ActionResult, PageSnapshot } from './vendor/bhjs/page';
import type { ConnectOptions, Session } from './vendor/bhjs/session';
import type { SnapshotRef } from './vendor/bhjs/snapshot';

const debug = getDebug('web:browser-harness');

/**
 * browser-harness-js keeps the ref table and its invalidation epoch private.
 * The device reads them through this view instead of patching the vendored
 * SDK; the constructor checks they exist so an SDK update that renames them
 * fails loudly. (Upstream candidate: a public `page.describeRef(ref)`.)
 */
interface PageInternals {
  refs: Map<string, SnapshotRef>;
  epoch: number;
}

const internalsOf = (page: Page) => page as unknown as PageInternals;

const SNAPSHOT_MAX_CHARS = 1_000_000;
const SNAPSHOT_MAX_DEPTH = 100;
const REF_PATTERN = /^(?:f\d+)?s[A-Za-z0-9_-]{12}_\d+e\d+$/;
const RECENT_SNAPSHOTS = 3;
const FRAME_MATCH_REASON =
  'inside a frame: browser-harness-js acts on the top-level document only';
const NOT_OPERABLE = 'not an operable control';

export interface BrowserHarnessPageOptions extends TextInputOptions {
  /**
   * Exact origins (scheme://host[:port]) the harness may read and act on.
   * Tree locate abstains, and `Navigate` refuses, outside them; vision and
   * coordinate actions are not restricted.
   */
  allowedOrigins: string[];
  /**
   * Let guarded actions reach password, e-mail, name and other personal-data
   * fields, which browser-harness-js refuses by default. A test runner acts
   * with the host's authority, so this defaults to true. Passed to the SDK's
   * `allowSensitive` grant: `connect` creates the page with it; a page handed
   * to the constructor keeps the grant it was created with. Default: true.
   */
  allowSensitiveFields?: boolean;
  /** Per-call timeout for harness reads and actions, 1..60000 ms. Default: 30000. */
  timeoutMs?: number;
}

export interface BrowserHarnessConnectOptions
  extends Omit<BrowserHarnessPageOptions, 'allowedOrigins'> {
  /** How to reach Chrome: `{ wsUrl }`, `{ port }` or `{ profileDir }`. */
  connect: ConnectOptions;
  /** Attach to this existing tab. */
  targetId?: string;
  /** Or open this URL in a new tab, closed again on `destroy()`. */
  url?: string;
  /** Default: the origin of `url`, or of the attached tab's URL. */
  allowedOrigins?: string[];
}

interface SnapshotCacheEntry {
  snapshot: PageSnapshot;
  revision: string;
  epoch: number;
  stamp?: string;
  entries: Map<string, HarnessRefEntry>;
}

/**
 * A Midscene web interface backed by browser-harness-js over raw CDP.
 *
 * The accessibility tree is the action address space: `locateInTree` binds a
 * label to refs from the whole snapshot, `actOnRef` acts once through the
 * harness's guarded locator, and vision with coordinate input stays the
 * fallback for everything the tree cannot decide.
 */
export class BrowserHarnessPage extends AbstractWebPage {
  interfaceType = 'browser-harness';

  readonly page: Page;
  readonly session: Session;
  readonly allowedOrigins: string[];
  override readonly keyboardTypeDelay?: number;
  override readonly inputStrategy?: TextInputOptions['inputStrategy'];

  override cacheFeatureForPoint: AbstractWebPage['cacheFeatureForPoint'] =
    undefined;
  override rectMatchesCacheFeature: AbstractWebPage['rectMatchesCacheFeature'] =
    undefined;
  override getElementsNodeTree: AbstractWebPage['getElementsNodeTree'] =
    undefined;
  override describe: AbstractWebPage['describe'] = undefined;
  override beforeInvokeAction: AbstractWebPage['beforeInvokeAction'] =
    undefined;
  override afterInvokeAction: AbstractWebPage['afterInvokeAction'] = undefined;

  private readonly allowSensitiveFields: boolean;
  private readonly timeoutMs: number;
  private readonly operability: InteractionController;
  private readonly owned?: { browser: Browser; closeTab: boolean };
  private cache?: SnapshotCacheEntry;
  private recent: SnapshotCacheEntry[] = [];
  private counter?: { key: string; contextId: number };
  private latestMouse = { x: 0, y: 0 };
  private destroyed = false;

  constructor(
    page: Page,
    session: Session,
    options: BrowserHarnessPageOptions,
    owned?: { browser: Browser; closeTab: boolean },
  ) {
    super();
    const internals = internalsOf(page);
    if (
      !(internals.refs instanceof Map) ||
      typeof internals.epoch !== 'number'
    ) {
      throw new Error(
        'The vendored browser-harness-js Page no longer exposes refs and epoch; update the BrowserHarnessPage adapter with the SDK',
      );
    }
    this.page = page;
    this.session = session;
    this.allowedOrigins = [...options.allowedOrigins];
    this.allowSensitiveFields = options.allowSensitiveFields ?? true;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.keyboardTypeDelay = options.keyboardTypeDelay;
    this.inputStrategy = options.inputStrategy;
    this.owned = owned;
    this.operability = new InteractionController(session, {
      allowedOrigins: this.allowedOrigins,
      input: 'trusted',
      allowSensitive: this.allowSensitiveFields,
    });
  }

  /** Connect to Chrome over CDP and attach to (or open) one tab. */
  static async connect(
    options: BrowserHarnessConnectOptions,
  ): Promise<BrowserHarnessPage> {
    if (!options.targetId === !options.url) {
      throw new Error(
        'BrowserHarnessPage.connect needs exactly one of targetId or url',
      );
    }
    await ensureWebSocket();
    const browser = new Browser();
    try {
      await browser.connect({ ...options.connect, autoAllow: false });
      const timeoutMs = options.timeoutMs ?? 30_000;
      const allowSensitive = options.allowSensitiveFields ?? true;
      let allowedOrigins = options.allowedOrigins;
      let page: Page;
      if (options.targetId) {
        if (!allowedOrigins) {
          const tab = (await browser.tabs()).find(
            (t) => t.targetId === options.targetId,
          );
          if (!tab) throw new Error(`No page target ${options.targetId}`);
          allowedOrigins = [new URL(tab.url).origin];
        }
        page = await browser.attach(options.targetId, {
          allowedOrigins,
          input: 'trusted',
          timeoutMs,
          allowSensitive,
        });
      } else {
        allowedOrigins ??= [new URL(options.url!).origin];
        page = await browser.open(options.url!, {
          allowedOrigins,
          input: 'trusted',
          timeoutMs,
          allowSensitive,
        });
      }
      const device = new BrowserHarnessPage(
        page,
        browser.session,
        { ...options, allowedOrigins },
        { browser, closeTab: !!options.url },
      );
      // A background tab renders no frames, so screenshots and input stall.
      await device.dispatch('Page.bringToFront').catch(async (error) => {
        await device.destroy();
        throw error;
      });
      return device;
    } catch (error) {
      browser.disconnect();
      throw error;
    }
  }

  actionSpace(): DeviceAction[] {
    return commonWebActionsForWebPage(this);
  }

  // ---- reads (raw session calls: they never invalidate harness refs) ----

  private send<T = any>(
    method: string,
    params: unknown = {},
    sessionId = this.page.scope.sessionId,
  ): Promise<T> {
    if (this.destroyed) {
      return Promise.reject(new Error('BrowserHarnessPage was destroyed'));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(new Error(`${method} timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
    });
    return Promise.race([
      this.session._call(method, params, { sessionId }) as Promise<T>,
      timeout,
    ]).finally(() => clearTimeout(timer));
  }

  // ---- input (through the harness page: every call invalidates its refs) ----

  private dispatch<T = any>(method: string, params: unknown = {}): Promise<T> {
    if (this.destroyed) {
      return Promise.reject(new Error('BrowserHarnessPage was destroyed'));
    }
    return this.page.cdp(method, params);
  }

  async size(): Promise<Size> {
    const result = await this.send('Runtime.evaluate', {
      expression: '({ width: innerWidth, height: innerHeight })',
      returnByValue: true,
    });
    const value = result?.result?.value;
    if (
      !value ||
      !Number.isFinite(value.width) ||
      !Number.isFinite(value.height)
    ) {
      throw new Error('Could not read the viewport size');
    }
    return { width: value.width, height: value.height };
  }

  async screenshotBase64(): Promise<string> {
    const { data } = await this.send<{ data: string }>(
      'Page.captureScreenshot',
      {
        format: 'jpeg',
        quality: 90,
      },
    );
    return createImgBase64ByFormat('jpeg', data);
  }

  url = async (): Promise<string> => {
    const result = await this.send('Runtime.evaluate', {
      expression: 'location.href',
      returnByValue: true,
    });
    return String(result?.result?.value ?? '');
  };

  async evaluateJavaScript<T = any>(script: string): Promise<T> {
    const result = await this.dispatch('Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `evaluateJavaScript failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result?.value as T;
  }

  // ---- accessibility tree ----

  /**
   * The current snapshot: reused while the harness page has not invalidated
   * its refs (navigation, actions, raw input) and the main document has not
   * mutated since the snapshot was read; read again otherwise.
   */
  private async currentSnapshot(force = false): Promise<SnapshotCacheEntry> {
    const internals = internalsOf(this.page);
    // Read before the snapshot, so a mutation during the read is seen later.
    const stamp = await this.mutationStamp();
    if (
      !force &&
      this.cache &&
      stamp !== undefined &&
      stamp === this.cache.stamp &&
      internals.epoch === this.cache.epoch
    ) {
      return this.cache;
    }
    const snapshot = await this.page.snapshot({
      maxChars: SNAPSHOT_MAX_CHARS,
      maxDepth: SNAPSHOT_MAX_DEPTH,
    });
    if (snapshot.tree.includes('[snapshot truncated: maxDepth=')) {
      throw new Error(
        `The accessibility tree is deeper than ${SNAPSHOT_MAX_DEPTH} levels; the tree cannot tell whether a match is unique`,
      );
    }
    const entries = new Map<string, HarnessRefEntry>();
    const editability = fieldEditability(snapshot.tree);
    for (const [ref, info] of internals.refs) {
      const editable = editability.get(ref);
      entries.set(ref, {
        ref,
        role: info.role,
        name: info.name,
        ...(info.context ? { context: info.context } : {}),
        backendNodeId: info.backendNodeId,
        frameId: info.frame.frameId,
        sessionId: info.frame.sessionId,
        mainFrame: ref.startsWith('s'),
        ...(editable !== undefined ? { editable } : {}),
      });
    }
    const first = entries.keys().next().value;
    if (first !== undefined && !snapshot.tree.includes(`[ref=${first}]`)) {
      throw new Error('The page changed while reading the accessibility tree');
    }
    const entry: SnapshotCacheEntry = {
      snapshot,
      revision: snapshot.id,
      epoch: internals.epoch,
      stamp,
      entries,
    };
    this.cache = entry;
    this.recent = [entry, ...this.recent].slice(0, RECENT_SNAPSHOTS);
    return entry;
  }

  /** `<document identity>#<mutation count>`, or undefined when unreadable. */
  private async mutationStamp(): Promise<string | undefined> {
    try {
      const { frameTree } = await this.send('Page.getFrameTree');
      const frame = frameTree.frame;
      const key = JSON.stringify([frame.id, frame.loaderId, frame.url]);
      if (this.counter?.key !== key) {
        const world = await this.send('Page.createIsolatedWorld', {
          frameId: frame.id,
          worldName: 'midscene-harness-revision',
        });
        this.counter = { key, contextId: world.executionContextId };
      }
      const result = await this.send('Runtime.evaluate', {
        expression: MUTATION_COUNTER_EXPRESSION,
        contextId: this.counter.contextId,
        returnByValue: true,
      });
      const count = result?.result?.value;
      if (result.exceptionDetails || typeof count !== 'number') {
        throw new Error('mutation counter unavailable');
      }
      return `${key}#${count}`;
    } catch (error) {
      // Without a stamp nothing is cached: every locate reads a fresh tree.
      debug('mutation stamp unavailable: %s', error);
      this.counter = undefined;
      return undefined;
    }
  }

  private entryFor(ref: string): HarnessRefEntry | undefined {
    for (const snapshot of this.recent) {
      const entry = snapshot.entries.get(ref);
      if (entry) return entry;
    }
    return undefined;
  }

  /** Rect (top-level viewport CSS pixels) and perceivability per entry. */
  private async probe(
    entries: HarnessRefEntry[],
  ): Promise<Map<string, PerceivabilityProbe>> {
    const probes = new Map<string, PerceivabilityProbe>();
    if (!entries.length) return probes;
    const group = `midscene-harness-probe-${Date.now()}-${Math.random()}`;
    const worlds = new Map<string, number>();
    const sessions = new Set<string>();
    const worldFor = async (sessionId: string, frameId: string) => {
      const key = `${sessionId}|${frameId}`;
      let contextId = worlds.get(key);
      if (contextId === undefined) {
        const world = await this.send(
          'Page.createIsolatedWorld',
          { frameId, worldName: 'midscene-harness-probe' },
          sessionId,
        );
        contextId = world.executionContextId as number;
        worlds.set(key, contextId);
      }
      return contextId;
    };
    const callOn = async (
      sessionId: string,
      frameId: string,
      backendNodeId: number,
      functionDeclaration: string,
    ) => {
      sessions.add(sessionId);
      const executionContextId = await worldFor(sessionId, frameId);
      const { object } = await this.send(
        'DOM.resolveNode',
        { backendNodeId, executionContextId, objectGroup: group },
        sessionId,
      );
      if (!object?.objectId) throw new Error(`Node ${backendNodeId} is gone`);
      const result = await this.send(
        'Runtime.callFunctionOn',
        { objectId: object.objectId, functionDeclaration, returnByValue: true },
        sessionId,
      );
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ??
            result.exceptionDetails.text,
        );
      }
      return result.result.value;
    };
    try {
      let frames:
        | { frameId: string; sessionId: string; parentId?: string }[]
        | undefined;
      const offsets = new Map<string, { left: number; top: number }>();
      const offsetOf = async (
        frameId: string,
      ): Promise<{ left: number; top: number }> => {
        const known = offsets.get(frameId);
        if (known) return known;
        frames ??= (await this.page.frames()).frames;
        const frame = frames.find((f) => f.frameId === frameId);
        if (!frame?.parentId) {
          return { left: 0, top: 0 };
        }
        const parent = frames.find((f) => f.frameId === frame.parentId);
        if (!parent) throw new Error(`Frame ${frameId} has no readable parent`);
        const { backendNodeId } = await this.send(
          'DOM.getFrameOwner',
          { frameId },
          parent.sessionId,
        );
        const own = await callOn(
          parent.sessionId,
          parent.frameId,
          backendNodeId,
          FRAME_OFFSET_FUNCTION,
        );
        const above = await offsetOf(parent.frameId);
        const offset = {
          left: own.left + above.left,
          top: own.top + above.top,
        };
        offsets.set(frameId, offset);
        return offset;
      };
      for (const entry of entries) {
        const probe: PerceivabilityProbe = await callOn(
          entry.sessionId,
          entry.frameId,
          entry.backendNodeId,
          PERCEIVABILITY_FUNCTION,
        );
        if (!entry.mainFrame) {
          const offset = await offsetOf(entry.frameId);
          probe.rect = {
            ...probe.rect,
            left: probe.rect.left + offset.left,
            top: probe.rect.top + offset.top,
          };
        }
        probes.set(entry.ref, probe);
      }
      return probes;
    } finally {
      for (const sessionId of sessions) {
        await this.send(
          'Runtime.releaseObjectGroup',
          { objectGroup: group },
          sessionId,
        ).catch(() => {});
      }
    }
  }

  private toMatch(
    entry: HarnessRefEntry,
    probe: PerceivabilityProbe,
    revision: string,
  ): TreeMatch {
    return {
      ref: entry.ref,
      rect: probe.rect,
      role: entry.role,
      name: entry.name,
      revision,
      perceivable: entry.mainFrame
        ? { perceivable: probe.ok, ...(probe.why ? { why: probe.why } : {}) }
        : { perceivable: false, why: FRAME_MATCH_REASON },
      ...(entry.editable !== undefined ? { editable: entry.editable } : {}),
    };
  }

  /**
   * Every element of the whole snapshot the query names, with its rect in
   * CSS pixels and a deterministic perceivability verdict filled in.
   */
  async locateInTree(
    query: TreeQuery,
    signal?: AbortSignal,
  ): Promise<TreeMatch[]> {
    const cache = await this.currentSnapshot();
    signal?.throwIfAborted();
    const found = matchEntries(cache.entries.values(), query);
    const probes = await this.probe(found);
    signal?.throwIfAborted();
    return found.map((entry) =>
      this.toMatch(entry, probes.get(entry.ref)!, cache.revision),
    );
  }

  async perceivable(
    match: TreeMatch,
    signal?: AbortSignal,
  ): Promise<Perceivability> {
    const entry = this.entryFor(match.ref);
    if (!entry) throw new Error(`Unknown ref ${match.ref}`);
    if (!entry.mainFrame)
      return { perceivable: false, why: FRAME_MATCH_REASON };
    const probe = (await this.probe([entry])).get(entry.ref)!;
    signal?.throwIfAborted();
    return { perceivable: probe.ok, ...(probe.why ? { why: probe.why } : {}) };
  }

  /**
   * Whether browser-harness-js can perform the operation on this element by
   * ref. False sends core down the coordinate path: operations the harness
   * has no guarded form of (double click, right click, hover, keys outside
   * its allowlist), frames, and elements its guard does not operate (date
   * pickers, sliders, ...). Refusals that depend on state (disabled, hidden,
   * covered) answer true so `actOnRef` reports them as `blocked`.
   */
  async supportsRefOperation(
    match: TreeMatch,
    operation: RefOperation,
    payload?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const call = harnessCallFor(operation, payload);
    if (!call) return false;
    const entry = this.entryFor(match.ref);
    // An unknown ref is answered by actOnRef as stale.
    if (!entry) return true;
    if (!entry.mainFrame) return false;
    if (call.method === 'scrollIntoView') return true;
    let observation: Awaited<ReturnType<InteractionController['observe']>>;
    try {
      observation = await this.operability
        .observe(
          { scope: this.page.scope, backendNodeId: entry.backendNodeId },
          { signal },
        )
        .finally(() => this.operability.invalidate(this.page.scope));
    } catch (error) {
      signal?.throwIfAborted();
      // The element or page changed under the probe; actOnRef revalidates
      // and answers with a stale or blocked receipt.
      debug('operability probe failed: %s', error);
      return true;
    }
    const candidate = observation.candidates[0];
    if (candidate) {
      const offered = candidate.operations;
      return (
        offered.includes(guardOperationFor(call)) ||
        (offered.length === 1 && offered[0] === 'scroll_into_view')
      );
    }
    // The ref was replaced by a later snapshot: actOnRef reports it stale.
    if (!internalsOf(this.page).refs.get(match.ref)) return true;
    // The guard says why it offers nothing: only "not an operable control" is
    // a limit of the harness; state refusals (disabled, covered) are blocked.
    return !(observation.refusal ?? '').startsWith(NOT_OPERABLE);
  }

  private async perform(
    ref: string,
    call: HarnessLocatorCall,
    signal?: AbortSignal,
  ): Promise<ActionResult> {
    const locator = this.page.locator(ref);
    const options = signal ? { signal } : {};
    switch (call.method) {
      case 'click':
        return locator.click(options);
      case 'fill':
        return locator.fill(call.text, options);
      case 'press':
        return locator.press(call.key, options);
      case 'selectOption':
        return locator.selectOption(call.option, options);
      case 'scrollIntoView':
        return locator.scrollIntoView(options);
    }
  }

  /**
   * The one element in a fresh snapshot with the stale ref's exact identity
   * (role, name and context), if it is unique and perceivable.
   */
  private async rebind(
    ref: string,
  ): Promise<{ entry?: HarnessRefEntry; note: string }> {
    const original = this.entryFor(ref);
    if (!original) {
      return { note: "not rebound: the ref is not from this page's snapshots" };
    }
    const fresh = await this.currentSnapshot(true);
    const candidates = [...fresh.entries.values()].filter(
      (entry) =>
        entry.mainFrame &&
        entry.role === original.role &&
        normalizeName(entry.name) === normalizeName(original.name) &&
        (entry.context ?? '') === (original.context ?? ''),
    );
    if (candidates.length !== 1) {
      return {
        note: `not rebound: ${candidates.length} elements have the same role, name and context`,
      };
    }
    const [candidate] = candidates;
    const probe = (await this.probe([candidate])).get(candidate.ref)!;
    if (!probe.ok) {
      return {
        note: `not rebound: the element is not perceivable (${probe.why})`,
      };
    }
    return { entry: candidate, note: `rebound to ${candidate.ref}` };
  }

  /**
   * Act once through browser-harness-js's guarded locator. A stale ref is
   * rebound once by exact identity before `stale` is returned.
   */
  async actOnRef(
    match: TreeMatch,
    operation: RefOperation,
    payload?: string,
    signal?: AbortSignal,
  ): Promise<ActReceipt> {
    const call = harnessCallFor(operation, payload);
    if (!call) {
      return {
        status: 'blocked',
        verified: null,
        reason: `browser-harness-js has no guarded ${operation}${payload ? ` "${payload}"` : ''}`,
      };
    }
    if (!REF_PATTERN.test(match.ref)) {
      return {
        status: 'stale',
        verified: null,
        reason: `not a browser-harness-js ref: ${match.ref}`,
      };
    }
    const first: HarnessActionResult = await this.perform(
      match.ref,
      call,
      signal,
    );
    if (first.status !== 'stale') {
      return toActReceipt(first);
    }
    signal?.throwIfAborted();
    let rebound: Awaited<ReturnType<BrowserHarnessPage['rebind']>>;
    try {
      rebound = await this.rebind(match.ref);
    } catch (error) {
      return toActReceipt(first, {
        rebindNote: `not rebound: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (!rebound.entry) {
      return toActReceipt(first, { rebindNote: rebound.note });
    }
    signal?.throwIfAborted();
    const second = await this.perform(rebound.entry.ref, call, signal);
    return toActReceipt(second, {
      rebound: { from: match.ref, to: rebound.entry.ref },
    });
  }

  /** The snapshot as a `UITreeSnapshot`; boxes for top-level document nodes. */
  async getUITree(): Promise<UITreeSnapshot> {
    const cache = await this.currentSnapshot();
    const boxes = await this.documentBoxes();
    const backendOf = new Map<string, number>();
    for (const entry of cache.entries.values()) {
      if (entry.mainFrame) backendOf.set(entry.ref, entry.backendNodeId);
    }
    const roots = parseSnapshotTree(cache.snapshot.tree, (ref) => {
      const backend = backendOf.get(ref);
      return backend === undefined ? undefined : boxes.get(backend);
    });
    const zero = { left: 0, top: 0, width: 0, height: 0 };
    const root: UiNode =
      roots.length === 1
        ? roots[0]
        : {
            type: 'document',
            attrs: { url: cache.snapshot.url },
            bounds: zero,
            children: roots,
          };
    return {
      platform: 'web',
      capturedAt: Date.now(),
      root,
      revision: cache.revision,
    };
  }

  /** Viewport boxes (CSS pixels) of the top-level document's laid-out nodes. */
  private async documentBoxes(): Promise<Map<number, Rect>> {
    const snapshot = await this.send('DOMSnapshot.captureSnapshot', {
      computedStyles: [],
    });
    const doc = snapshot.documents?.[0];
    const boxes = new Map<number, Rect>();
    if (!doc) return boxes;
    const backendIds: number[] = doc.nodes.backendNodeId;
    const scrollX = doc.scrollOffsetX ?? 0;
    const scrollY = doc.scrollOffsetY ?? 0;
    doc.layout.nodeIndex.forEach((nodeIndex: number, i: number) => {
      const [x, y, width, height] = doc.layout.bounds[i];
      const backend = backendIds[nodeIndex];
      if (!boxes.has(backend)) {
        boxes.set(backend, {
          left: x - scrollX,
          top: y - scrollY,
          width,
          height,
        });
      }
    });
    return boxes;
  }

  // ---- navigation ----

  async navigate(url: string): Promise<void> {
    const result = await this.page.goto(url);
    if (result.status !== 'executed') {
      throw new Error(
        `Navigate to ${url} ${result.status}: ${result.reason ?? 'no reason given'}${result.reason === 'origin_denied' ? ` (allowed origins: ${this.allowedOrigins.join(', ')})` : ''}`,
      );
    }
  }

  private async afterLoad(trigger: () => Promise<unknown>): Promise<void> {
    const sessionId = this.page.scope.sessionId;
    let done!: () => void;
    const loaded = new Promise<void>((resolve) => {
      done = resolve;
    });
    const off = this.session.onEvent((method, _params, sid) => {
      if (sid === sessionId && method === 'Page.loadEventFired') done();
    });
    try {
      await trigger();
      await Promise.race([loaded, sleep(30_000)]);
    } finally {
      off();
    }
  }

  async reload(): Promise<void> {
    await this.afterLoad(() => this.dispatch('Page.reload', {}));
  }

  private async history(step: -1 | 1): Promise<void> {
    const { currentIndex, entries } = await this.send(
      'Page.getNavigationHistory',
    );
    const target = entries[currentIndex + step];
    if (!target) return;
    await this.afterLoad(() =>
      this.dispatch('Page.navigateToHistoryEntry', { entryId: target.id }),
    );
  }

  async goBack(): Promise<void> {
    await this.history(-1);
  }

  async goForward(): Promise<void> {
    await this.history(1);
  }

  async stopLoading(): Promise<void> {
    await this.dispatch('Page.stopLoading', {});
  }

  // ---- coordinate input (the vision fallback) ----

  override get mouse() {
    return {
      click: async (
        x: number,
        y: number,
        options?: { button?: MouseButton; count?: number },
      ) => {
        const { button = 'left', count = 1 } = options ?? {};
        await this.mouse.move(x, y);
        for (let i = 0; i < count; i++) {
          const clickCount = i + 1;
          await this.dispatch('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x,
            y,
            button,
            buttons: 1,
            clickCount,
          });
          await this.dispatch('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x,
            y,
            button,
            buttons: 0,
            clickCount,
          });
        }
      },
      wheel: async (
        deltaX: number,
        deltaY: number,
        startX?: number,
        startY?: number,
      ) => {
        const x = startX ?? this.latestMouse.x;
        const y = startY ?? this.latestMouse.y;
        await this.dispatch('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x,
          y,
          deltaX,
          deltaY,
        });
        this.latestMouse = { x, y };
      },
      move: async (x: number, y: number) => {
        await this.dispatch('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x,
          y,
        });
        this.latestMouse = { x, y };
      },
      drag: async (
        from: { x: number; y: number },
        to: { x: number; y: number },
      ) => {
        await this.mouse.move(from.x, from.y);
        await this.dispatch('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: from.x,
          y: from.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        });
        await sleep(200);
        await this.dispatch('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: to.x,
          y: to.y,
          button: 'left',
          buttons: 1,
        });
        await sleep(200);
        await this.dispatch('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: to.x,
          y: to.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        });
        this.latestMouse = { ...to };
      },
    };
  }

  override get keyboard() {
    const keyboard = new CdpKeyboard({
      send: (method: string, params?: unknown) => this.dispatch(method, params),
    } as ConstructorParameters<typeof CdpKeyboard>[0]);
    return {
      type: async (text: string, options?: { delay?: number }) => {
        await keyboard.type(text, { delay: options?.delay ?? 0 });
      },
      insertText: async (text: string) => {
        await this.dispatch('Input.insertText', { text });
      },
      press: async (
        action:
          | { key: KeyInput; command?: string }
          | { key: KeyInput; command?: string }[],
      ) => {
        const keys = Array.isArray(action) ? action : [action];
        for (const k of keys) {
          await keyboard.down(k.key, {
            commands: k.command ? [k.command] : [],
          });
        }
        for (const k of [...keys].reverse()) {
          await keyboard.up(k.key);
        }
      },
    };
  }

  override async clearInput(element?: ElementInfo): Promise<void> {
    if (!element) return;
    await this.mouse.click(element.center[0], element.center[1]);
    await this.selectAllFocused();
    await this.keyboard.press({ key: 'Backspace' });
  }

  override async selectAllInput(element?: ElementInfo): Promise<void> {
    if (!element) {
      throw new Error('Bulk replace input requires a target element');
    }
    await this.mouse.click(element.center[0], element.center[1]);
    await this.selectAllFocused();
  }

  private async selectAllFocused(): Promise<void> {
    const selected = await this.dispatch('Runtime.evaluate', {
      expression: selectAllInputScript,
      returnByValue: true,
    });
    if (selected?.result?.value === true) return;
    await this.dispatch('Input.dispatchKeyEvent', {
      type: 'keyDown',
      commands: ['selectAll'],
    });
    await this.dispatch('Input.dispatchKeyEvent', {
      type: 'keyUp',
      commands: ['selectAll'],
    });
  }

  private async scrollBy(
    deltaX: number,
    deltaY: number,
    startingPoint?: Point,
  ): Promise<void> {
    if (startingPoint) {
      await this.mouse.move(startingPoint.left, startingPoint.top);
    } else if (!this.latestMouse.x && !this.latestMouse.y) {
      const { width, height } = await this.size();
      this.latestMouse = { x: width / 2, y: height / 2 };
    }
    await this.mouse.wheel(deltaX, deltaY);
  }

  async scrollUntilTop(startingPoint?: Point) {
    await this.scrollBy(0, -9_999_999, startingPoint);
  }

  async scrollUntilBottom(startingPoint?: Point) {
    await this.scrollBy(0, 9_999_999, startingPoint);
  }

  async scrollUntilLeft(startingPoint?: Point) {
    await this.scrollBy(-9_999_999, 0, startingPoint);
  }

  async scrollUntilRight(startingPoint?: Point) {
    await this.scrollBy(9_999_999, 0, startingPoint);
  }

  async scrollUp(distance?: number, startingPoint?: Point) {
    const { height } = await this.size();
    await this.scrollBy(0, -(distance || height * 0.7), startingPoint);
  }

  async scrollDown(distance?: number, startingPoint?: Point) {
    const { height } = await this.size();
    await this.scrollBy(0, distance || height * 0.7, startingPoint);
  }

  async scrollLeft(distance?: number, startingPoint?: Point) {
    const { width } = await this.size();
    await this.scrollBy(-(distance || width * 0.7), 0, startingPoint);
  }

  async scrollRight(distance?: number, startingPoint?: Point) {
    const { width } = await this.size();
    await this.scrollBy(distance || width * 0.7, 0, startingPoint);
  }

  async longPress(x: number, y: number, duration?: number) {
    await this.mouse.move(x, y);
    await this.dispatch('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await sleep(Math.max(duration || 500, 300));
    await this.dispatch('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
  }

  async swipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    duration?: number,
  ) {
    const steps = 20;
    const delay = Math.min(Math.max(duration || 300, 150), 500) / steps;
    await this.mouse.move(from.x, from.y);
    await this.dispatch('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: from.x,
      y: from.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let i = 1; i <= steps; i++) {
      await this.dispatch('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: from.x + ((to.x - from.x) * i) / steps,
        y: from.y + ((to.y - from.y) * i) / steps,
        button: 'left',
        buttons: 1,
      });
      await sleep(delay);
    }
    await this.dispatch('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: to.x,
      y: to.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    this.latestMouse = { ...to };
  }

  async pinch(
    centerX: number,
    centerY: number,
    startDistance: number,
    endDistance: number,
    duration = 500,
  ): Promise<void> {
    const steps = 20;
    const point = (half: number) => [
      { x: Math.round(centerX), y: Math.round(centerY - half), id: 0 },
      { x: Math.round(centerX), y: Math.round(centerY + half), id: 1 },
    ];
    await this.dispatch('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: point(startDistance / 2),
      modifiers: 0,
    });
    for (let i = 1; i <= steps; i++) {
      const half =
        (startDistance + ((endDistance - startDistance) * i) / steps) / 2;
      await this.dispatch('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: point(half),
        modifiers: 0,
      });
      await sleep(duration / steps);
    }
    await this.dispatch('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
      modifiers: 0,
    });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.operability.close();
    try {
      if (this.owned?.closeTab) {
        await this.page
          .close()
          .catch((error) => debug('close tab failed: %s', error));
      } else {
        this.page.dispose();
      }
    } finally {
      this.destroyed = true;
      this.owned?.browser.disconnect();
    }
  }
}

/**
 * browser-harness-js opens its CDP socket with the global `WebSocket`, which
 * Node has unflagged only since v22. On older runtimes use `ws` instead.
 */
async function ensureWebSocket(): Promise<void> {
  if (
    typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'undefined'
  ) {
    return;
  }
  const { WebSocket } = await import('ws');
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocket;
}
