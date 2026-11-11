import { once } from 'node:events';
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { BrowserHarnessPage, Page, Session } from '@/browser-harness';
import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';
import puppeteer, { type Browser as PuppeteerBrowser } from 'puppeteer';
import ts from 'typescript';
import {
  type NavigationParams,
  type NavigationState,
  initialNavigation,
  navigationStep,
} from '../../src/browser-harness/vendor/bhjs/navigation-state';

const origin = 'http://127.0.0.1:12345';
const turn = () => new Promise((resolve) => setImmediate(resolve));

type Api = {
  emit: (method: string, params: unknown, sid?: string) => void;
  commit: (
    loader: string,
    sid?: string,
    id?: string,
    parentId?: string,
  ) => void;
  dcl: (loader: string, sid?: string, id?: string) => void;
  listeners: Set<(method: string, params: unknown, sid?: string) => void>;
};
type Hooks = {
  tree?: (calls: number, api: Api) => void;
  evaluate?: (api: Api) => boolean;
};

/** A Page over a scripted CDP session: the root frame starts on loader "before". */
function harness(
  onNavigate: (api: Api) => Promise<unknown>,
  hooks: Hooks = {},
) {
  const listeners: Api['listeners'] = new Set();
  let frame = { id: 'root', loaderId: 'before', url: origin };
  let treeCalls = 0;
  const session = new Session() as any;
  session.isConnected = () => true;
  session.getConnectionGeneration = () => 1;
  session.onEvent = (
    fn: (method: string, params: unknown, sid?: string) => void,
  ) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const emit: Api['emit'] = (method, params, sid = 'owned') => {
    for (const fn of [...listeners]) fn(method, params, sid);
  };
  const commit: Api['commit'] = (
    loader,
    sid = 'owned',
    id = 'root',
    parentId?: string,
  ) => {
    if (sid === 'owned' && !parentId)
      frame = { id, loaderId: loader, url: origin };
    emit(
      'Page.frameNavigated',
      { frame: { id, loaderId: loader, url: origin, parentId } },
      sid,
    );
  };
  const dcl: Api['dcl'] = (loader, sid = 'owned', id = 'root') =>
    emit(
      'Page.lifecycleEvent',
      { name: 'DOMContentLoaded', frameId: id, loaderId: loader },
      sid,
    );
  const api: Api = { emit, commit, dcl, listeners };
  session._call = async (method: string) => {
    if (method === 'Page.enable' || method === 'Page.setLifecycleEventsEnabled')
      return {};
    if (method === 'Page.getFrameTree') {
      treeCalls++;
      hooks.tree?.(treeCalls, api);
      return { frameTree: { frame: { ...frame } } };
    }
    if (method === 'Page.navigate') return await onNavigate(api);
    if (method === 'Page.createIsolatedWorld')
      return { executionContextId: 12 };
    if (method === 'Runtime.evaluate')
      return { result: { value: hooks.evaluate?.(api) ?? true } };
    throw new Error('fixture snapshot intentionally unavailable');
  };
  const page = new Page(session, {
    sessionId: 'owned',
    allowedOrigins: [origin],
    timeoutMs: 1000,
  });
  return {
    ...api,
    page,
    baseListeners: listeners.size,
    goto: () => page.goto(`${origin}/next`, { timeoutMs: 300 }),
  };
}

/** Run goto, let `release` act once it is under way, and prove it had not settled before. */
async function heldUntil(
  h: ReturnType<typeof harness>,
  started: Promise<unknown>,
  release: () => void,
) {
  let done = false;
  const pending = h.goto().then((result) => {
    done = true;
    return result;
  });
  await started;
  await turn();
  expect(done).toBe(false);
  release();
  return pending;
}

function signal() {
  let fire!: () => void;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  return { fire, fired };
}

describe('navigation readiness policy', () => {
  const params: NavigationParams = {
    session: 1,
    expectedFrame: 1,
    expectedLoader: 2,
  };
  const anchored = (): NavigationState =>
    navigationStep(params, initialNavigation(), {
      kind: 'commit',
      session: 1,
      frame: 1,
      loader: 2,
      root: true,
    });

  it('anchors only on the requested root commit of its own session', () => {
    const start = initialNavigation();
    expect(
      navigationStep(params, start, {
        kind: 'commit',
        session: 1,
        frame: 1,
        loader: 9,
        root: true,
      }),
    ).toBe(start);
    expect(
      navigationStep(params, start, {
        kind: 'commit',
        session: 2,
        frame: 1,
        loader: 2,
        root: true,
      }),
    ).toBe(start);
    expect(
      navigationStep(params, start, {
        kind: 'commit',
        session: 1,
        frame: 1,
        loader: 2,
      }),
    ).toBe(start);
    expect(anchored()).toMatchObject({
      frame: 1,
      loader: 2,
      committed: true,
      anchored: true,
      ready: false,
    });
    // Once anchored, a later root commit (a redirect or replacement) moves the chain and clears readiness.
    const ready = navigationStep(params, anchored(), {
      kind: 'dcl',
      session: 1,
      frame: 1,
      loader: 2,
    });
    expect(
      navigationStep(params, ready, {
        kind: 'commit',
        session: 1,
        frame: 1,
        loader: 3,
        root: true,
      }),
    ).toMatchObject({ loader: 3, ready: false });
  });

  it('becomes ready only on DOMContentLoaded of the current document', () => {
    for (const event of [
      { kind: 'dcl' as const, session: 2, frame: 1, loader: 2 },
      { kind: 'dcl' as const, session: 1, frame: 7, loader: 2 },
      { kind: 'dcl' as const, session: 1, frame: 1, loader: 8 },
    ]) {
      expect(navigationStep(params, anchored(), event).ready).toBe(false);
    }
    expect(
      navigationStep(params, initialNavigation(), {
        kind: 'dcl',
        session: 1,
        frame: 1,
        loader: 2,
      }).ready,
    ).toBe(false);
    const ready = navigationStep(params, anchored(), {
      kind: 'dcl',
      session: 1,
      frame: 1,
      loader: 2,
    });
    expect(ready.ready).toBe(true);
    expect(
      navigationStep(params, ready, {
        kind: 'reset',
        session: 1,
        frame: 1,
        loader: 2,
      }).ready,
    ).toBe(false);
    const started = navigationStep(params, ready, {
      kind: 'start',
      session: 1,
      frame: 1,
    });
    expect(started).toMatchObject({
      pending: true,
      committed: false,
      ready: false,
    });
    expect(
      navigationStep(params, started, {
        kind: 'dcl',
        session: 1,
        frame: 1,
        loader: 2,
      }).ready,
    ).toBe(false);
  });

  it('is terminal on timeout or an owned failure', () => {
    const ready = navigationStep(params, anchored(), {
      kind: 'dcl',
      session: 1,
      frame: 1,
      loader: 2,
    });
    expect(navigationStep(params, ready, { kind: 'fail', session: 2 })).toBe(
      ready,
    );
    const failed = navigationStep(params, ready, { kind: 'fail', session: 1 });
    expect(failed).toMatchObject({ ready: false, terminal: true });
    expect(
      navigationStep(params, failed, {
        kind: 'commit',
        session: 1,
        frame: 1,
        loader: 2,
        root: true,
      }),
    ).toBe(failed);
    expect(
      navigationStep(params, anchored(), { kind: 'timeout' }),
    ).toMatchObject({ terminal: true });
  });
});

describe('Page.goto document readiness', () => {
  it('rejects another in-flight document while navigate is answered', async () => {
    const replied = signal();
    const h = harness(async (a) => {
      a.commit('inflight-A');
      a.dcl('inflight-A');
      replied.fire();
      return { frameId: 'root', loaderId: 'requested-B' };
    });
    try {
      const result = await heldUntil(h, replied.fired, () => {
        h.commit('requested-B');
        h.dcl('requested-B');
      });
      expect(result).toMatchObject({
        status: 'executed',
        reason: 'document_ready',
        verified: null,
      });
    } finally {
      h.page.dispose();
    }
  });

  it('fails closed when events overflow before navigate answers', async () => {
    const h = harness(async (a) => {
      for (let i = 0; i < 130; i++) a.dcl('old');
      return { frameId: 'root', loaderId: 'requested-B' };
    });
    try {
      expect(await h.goto()).toEqual({
        status: 'outcome_unknown',
        reason: 'navigation_event_capacity',
        verified: null,
      });
    } finally {
      h.page.dispose();
    }
  });

  it('keeps events that arrive before the navigate reply, including a replacement', async () => {
    for (const events of [
      (a: Api) => {
        a.commit('first');
        a.dcl('first');
      },
      (a: Api) => {
        a.commit('first');
        a.commit('replacement');
        a.dcl('replacement');
      },
    ]) {
      const h = harness(async (a) => {
        events(a);
        return { frameId: 'root', loaderId: 'first' };
      });
      try {
        expect(await h.goto()).toMatchObject({
          status: 'executed',
          verified: null,
        });
      } finally {
        h.page.dispose();
      }
    }
  });

  for (const row of [
    { name: 'a foreign session', sid: 'other', id: 'root', loader: 'first' },
    { name: 'a child frame', sid: 'owned', id: 'child', loader: 'first' },
    { name: 'a stale loader', sid: 'owned', id: 'root', loader: 'old' },
  ]) {
    it(`does not settle on DOMContentLoaded from ${row.name}`, async () => {
      const started = signal();
      const h = harness(async (a) => {
        a.commit('first');
        started.fire();
        return { frameId: 'root', loaderId: 'first' };
      });
      try {
        let done = false;
        const pending = h.goto().then((result) => {
          done = true;
          return result;
        });
        await started.fired;
        h.dcl(row.loader, row.sid, row.id);
        await turn();
        expect(done).toBe(false);
        h.dcl('first');
        expect((await pending).status).toBe('executed');
      } finally {
        h.page.dispose();
      }
    });
  }

  it('waits for a replacement document rather than the original one', async () => {
    const started = signal();
    const h = harness(async (a) => {
      a.commit('first');
      a.commit('replacement');
      a.dcl('first');
      started.fire();
      return { frameId: 'root', loaderId: 'first' };
    });
    try {
      expect(
        (await heldUntil(h, started.fired, () => h.dcl('replacement'))).status,
      ).toBe('executed');
    } finally {
      h.page.dispose();
    }
  });

  it('revalidates a replacement that commits during the snapshot', async () => {
    const replaced = signal();
    const h = harness(
      async (a) => {
        a.commit('first');
        a.dcl('first');
        return { frameId: 'root', loaderId: 'first' };
      },
      {
        tree(calls, a) {
          if (calls === 3) {
            a.commit('second');
            replaced.fire();
          }
        },
      },
    );
    try {
      expect(
        (await heldUntil(h, replaced.fired, () => h.dcl('second'))).status,
      ).toBe('executed');
    } finally {
      h.page.dispose();
    }
  });

  it('samples the original document for a same-document navigation, and waits while it parses', async () => {
    const plain = harness(async () => ({ frameId: 'root' }));
    try {
      expect((await plain.goto()).status).toBe('executed');
    } finally {
      plain.page.dispose();
    }
    const sampled = signal();
    const parsing = harness(async () => ({ frameId: 'root' }), {
      evaluate() {
        sampled.fire();
        return false;
      },
    });
    try {
      expect(
        (await heldUntil(parsing, sampled.fired, () => parsing.dcl('before')))
          .status,
      ).toBe('executed');
    } finally {
      parsing.page.dispose();
    }
  });

  it('does not let a same-document sample override a pending replacement', async () => {
    const sampled = signal();
    const h = harness(async () => ({ frameId: 'root' }), {
      evaluate(a) {
        a.emit('Page.frameStartedNavigating', {
          frameId: 'root',
          navigationType: 'differentDocument',
        });
        sampled.fire();
        return true;
      },
    });
    try {
      const result = await heldUntil(h, sampled.fired, () => {
        h.commit('replacement');
        h.dcl('replacement');
      });
      expect(result.status).toBe('executed');
    } finally {
      h.page.dispose();
    }
  });

  for (const row of [
    {
      name: 'no document',
      navigate: async () => ({ frameId: 'root', loaderId: 'pending' }),
      reason: 'Page call timed out',
    },
    {
      name: 'a missing DOMContentLoaded',
      navigate: async (a: Api) => {
        a.commit('first');
        return { frameId: 'root', loaderId: 'first' };
      },
      reason: 'Page call timed out',
    },
    {
      name: 'a transport failure',
      navigate: async () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' }),
      reason: 'net::ERR_CONNECTION_REFUSED',
    },
    {
      name: 'a download',
      navigate: async () => ({ isDownload: true }),
      reason: 'navigation_download',
    },
    {
      name: 'a missing frame identity',
      navigate: async () => ({ loaderId: 'x' }),
      reason: 'navigation_missing_identity',
    },
    {
      name: 'an ungranted redirect origin',
      navigate: async (a: Api) => {
        a.emit('Page.frameNavigated', {
          frame: {
            id: 'root',
            loaderId: 'foreign',
            url: 'https://ungranted.invalid/',
          },
        });
        a.dcl('foreign');
        return { frameId: 'root', loaderId: 'foreign' };
      },
      reason: 'origin_denied',
    },
    {
      name: 'a crashed target',
      navigate: async (a: Api) => {
        a.commit('first');
        a.emit('Inspector.targetCrashed', {});
        a.dcl('first');
        return { frameId: 'root', loaderId: 'first' };
      },
      reason: 'navigation_target_unavailable',
    },
  ]) {
    it(`never reports success for ${row.name}, and releases its listener`, async () => {
      const h = harness(row.navigate);
      try {
        const result = await h.page.goto(`${origin}/next`, { timeoutMs: 60 });
        expect(result).toEqual({
          status: 'outcome_unknown',
          reason: row.reason,
          verified: null,
        });
        expect(h.listeners.size).toBe(h.baseListeners);
      } finally {
        h.page.dispose();
      }
    });
  }

  it('ends on explicit cancellation', async () => {
    const started = signal();
    const h = harness(async () => {
      started.fire();
      return { frameId: 'root', loaderId: 'pending' };
    });
    const controller = new AbortController();
    try {
      const pending = h.page.goto(`${origin}/next`, {
        signal: controller.signal,
      });
      await started.fired;
      controller.abort(new Error('caller cancelled'));
      expect(await pending).toMatchObject({
        status: 'outcome_unknown',
        reason: 'caller cancelled',
      });
    } finally {
      h.page.dispose();
    }
  });

  it('cannot be released by an iframe, a new window or an old document', async () => {
    const nested = signal();
    const iframe = harness(async (a) => {
      a.commit('nested', 'owned', 'child', 'root');
      a.dcl('nested', 'owned', 'child');
      nested.fire();
      return { frameId: 'root', loaderId: 'first' };
    });
    try {
      const result = await heldUntil(iframe, nested.fired, () => {
        iframe.commit('first');
        iframe.dcl('first');
      });
      expect(result.status).toBe('executed');
    } finally {
      iframe.page.dispose();
    }
    const popup = harness(async (a) => {
      a.commit('first');
      a.emit('Page.frameRequestedNavigation', {
        frameId: 'root',
        disposition: 'newWindow',
      });
      a.dcl('first');
      return { frameId: 'root', loaderId: 'first' };
    });
    try {
      expect((await popup.goto()).status).toBe('executed');
    } finally {
      popup.page.dispose();
    }
    const old = signal();
    const stale = harness(async (a) => {
      a.commit('before');
      a.dcl('before');
      old.fire();
      return { frameId: 'root', loaderId: 'fresh' };
    });
    try {
      const result = await heldUntil(stale, old.fired, () => {
        stale.commit('fresh');
        stale.dcl('fresh');
      });
      expect(result.status).toBe('executed');
    } finally {
      stale.page.dispose();
    }
  });

  it('holds a requested same-tab replacement until it commits', async () => {
    const started = signal();
    const h = harness(async (a) => {
      a.commit('first');
      a.emit('Page.frameRequestedNavigation', {
        frameId: 'root',
        disposition: 'currentTab',
      });
      a.dcl('first');
      started.fire();
      return { frameId: 'root', loaderId: 'first' };
    });
    try {
      const result = await heldUntil(h, started.fired, () => {
        h.commit('second');
        h.dcl('second');
      });
      expect(result.status).toBe('executed');
    } finally {
      h.page.dispose();
    }
  });
});

describe('Page.goto against a real browser', () => {
  let server: Server;
  let base: string;
  let browser: PuppeteerBrowser;
  let device: BrowserHarnessPage;
  const held = new Set<ServerResponse>();
  const release = () => {
    for (const response of held) response.end();
    held.clear();
  };

  beforeAll(async () => {
    server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        if (request.url === '/held-image') {
          held.add(response);
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(
          request.url === '/ready'
            ? `<!doctype html><button onclick="document.querySelector('#result').textContent='clicked'">Continue</button><p id="result">waiting</p><img src="/held-image"><script>window.loaded=false;addEventListener('load',()=>window.loaded=true)</script>`
            : '<!doctype html><p>start</p>',
        );
      },
    );
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    device = await BrowserHarnessPage.connect({
      connect: { wsUrl: browser.wsEndpoint() },
      url: `${base}/start`,
    });
  }, 120_000);

  afterAll(async () => {
    release();
    await device?.destroy();
    await browser?.close();
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }, 120_000);

  it('settles on document readiness while the load event is still held', async () => {
    const evaluate = async (expression: string) =>
      (
        await device.page.cdp('Runtime.evaluate', {
          expression,
          returnByValue: true,
        })
      ).result.value;
    try {
      const result = await device.page.goto(`${base}/ready`, {
        timeoutMs: 10_000,
      });
      expect(result).toMatchObject({
        status: 'executed',
        reason: 'document_ready',
        verified: null,
      });
      expect(await evaluate('location.pathname')).toBe('/ready');
      expect(await evaluate('document.readyState')).toBe('interactive');
      expect(await evaluate('window.loaded')).toBe(false);
      const click = await device.page
        .getByRole('button', { name: 'Continue', exact: true })
        .click();
      expect(click.status).toBe('executed');
      expect(
        await evaluate("document.querySelector('#result').textContent"),
      ).toBe('clicked');
    } finally {
      release();
    }
  }, 60_000);
});

describe('browser-harness public types', () => {
  it('exports AXNode, InteractionCommit and target-constrained ScopeBinding', () => {
    const root = path.resolve(__dirname, '../..');
    const consumer = path.join(
      root,
      'tests/unit-test/public-types.consumer.ts',
    );
    const source = (
      exact: string,
    ) => `import type { AXNode, InteractionCommit, ScopeBinding } from '../../src/browser-harness/index';
const node: AXNode = { nodeId: '1', ignored: false, role: { type: 'role', value: 'button' } };
const binding: ScopeBinding = { kind: 'layout', rootSelector: '#scope', contextText: 'Workspace', targetRole: 'button', targetName: 'Go', targetExact: ${exact} };
const commit: InteractionCommit = { verified: null, source: null, blurred: null };
export { node, binding, commit };
`;
    const diagnose = (text: string) => {
      const options: ts.CompilerOptions = {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: true,
        types: [],
      };
      const host = ts.createCompilerHost(options);
      const readFile = host.readFile.bind(host);
      const fileExists = host.fileExists.bind(host);
      host.readFile = (file) =>
        path.resolve(file) === consumer ? text : readFile(file);
      host.fileExists = (file) =>
        path.resolve(file) === consumer || fileExists(file);
      const program = ts.createProgram([consumer], options, host);
      return ts
        .getPreEmitDiagnostics(program, program.getSourceFile(consumer))
        .map((diagnostic) =>
          ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
        );
    };
    expect(diagnose(source('false'))).toEqual([]);
    // The check bites: a mistyped constraint is a compile error.
    expect(diagnose(source("'no'")).length).toBeGreaterThan(0);
  });
});
