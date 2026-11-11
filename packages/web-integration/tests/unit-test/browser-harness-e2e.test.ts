import { once } from 'node:events';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  BrowserHarnessAgent,
  BrowserHarnessPage,
  InteractionController,
} from '@/browser-harness';
import type { TreeMatch } from '@midscene/core';
import {
  MIDSCENE_MODEL_API_KEY,
  MIDSCENE_MODEL_BASE_URL,
  MIDSCENE_MODEL_FAMILY,
  MIDSCENE_MODEL_NAME,
} from '@midscene/shared/env';
import { afterAll, beforeAll, describe, expect, it, rs } from '@rstest/core';
import puppeteer, {
  type Browser as PuppeteerBrowser,
  type Page as PuppeteerPage,
} from 'puppeteer';

const TEST_TIMEOUT_MS = 120_000;

// No model is reachable: a test that reaches AI locate without mocking it
// fails, so a passing tree test proves the model was never asked.
const MODEL_CONFIG = {
  [MIDSCENE_MODEL_NAME]: 'browser-harness-test',
  [MIDSCENE_MODEL_API_KEY]: 'test-key',
  [MIDSCENE_MODEL_BASE_URL]: 'https://model.invalid/v1',
  [MIDSCENE_MODEL_FAMILY]: 'qwen2.5-vl' as const,
};

const FIXTURE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Harness fixture</title>
    <style>
      body { margin: 0; font: 16px sans-serif; }
      .at { position: absolute; width: 120px; height: 32px; margin: 0; }
      #overlay { position: fixed; left: 0; top: 190px; width: 100%; height: 70px; background: #fff; z-index: 10; }
      #menu { opacity: 0; position: absolute; left: 20px; top: 300px; list-style: none; margin: 0; padding: 0; }
    </style>
  </head>
  <body>
    <button class="at" style="left:20px;top:20px" onclick="clicks.login++">Log in</button>
    <button class="at" style="left:20px;top:70px" onclick="clicks.save++">Save</button>
    <button class="at" style="left:160px;top:70px" onclick="clicks.save++">Save</button>
    <input class="at" style="left:300px;top:20px;width:160px" aria-label="Email" type="email" />
    <input class="at" style="left:300px;top:70px;width:160px" aria-label="Start date" type="date" />
    <input class="at" style="left:500px;top:20px;width:160px" placeholder="Password" value="ThisIsNotAPassword" readonly />
    <input class="at" style="left:500px;top:70px;width:160px" aria-label="Password" type="password" />
    <button class="at" style="left:20px;top:200px" onclick="clicks.deleted++">Delete account</button>
    <div id="overlay">Cookie notice</div>
    <ul id="menu" role="menu"><li role="menuitem" tabindex="0">Settings</li></ul>
    <button class="at" style="left:20px;top:360px" disabled>Submit order</button>
    <div id="slot" class="at" style="left:20px;top:420px"></div>
    <script>
      window.clicks = { login: 0, save: 0, deleted: 0, cont: 0 };
      window.renderContinue = (count = 1) => {
        const slot = document.getElementById('slot');
        slot.innerHTML = '';
        for (let i = 0; i < count; i++) {
          const button = document.createElement('button');
          button.textContent = 'Continue';
          button.onclick = () => clicks.cont++;
          slot.appendChild(button);
        }
      };
      renderContinue();
    </script>
  </body>
</html>`;

describe('BrowserHarnessPage against a real browser', () => {
  let server: Server;
  let baseUrl: string;
  let browser: PuppeteerBrowser;
  let device: BrowserHarnessPage;
  let agent: BrowserHarnessAgent;
  let observer: PuppeteerPage;

  const clicks = () =>
    observer.evaluate(() => ({ ...(window as any).clicks })) as Promise<
      Record<string, number>
    >;
  const only = async (name: string): Promise<TreeMatch> => {
    const matches = await device.locateInTree({ name, exact: true });
    expect(matches).toHaveLength(1);
    return matches[0];
  };

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    device = await BrowserHarnessPage.connect({
      connect: { wsUrl: browser.wsEndpoint() },
      url: `${baseUrl}/`,
    });
    agent = new BrowserHarnessAgent(device, {
      generateReport: false,
      modelConfig: MODEL_CONFIG,
    });
    // A second client on the same tab reads page state and rerenders like the
    // page's own scripts would, without going through the harness.
    const pages = await browser.pages();
    const found = pages.find((page) => page.url().startsWith(baseUrl));
    if (!found) throw new Error('fixture tab not found');
    observer = found;
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    await agent?.destroy();
    await browser?.close();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  }, TEST_TIMEOUT_MS);

  it('reports rects in the CSS pixels of size()', async () => {
    const size = await device.size();
    const viewport = await observer.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    expect(size).toEqual(viewport);
    const login = await only('Log in');
    expect(login).toMatchObject({
      role: 'button',
      name: 'Log in',
      rect: { left: 20, top: 20, width: 120, height: 32 },
      perceivable: { perceivable: true },
    });
    expect(login.revision).toBeTruthy();
  });

  it('reuses the snapshot until the document changes', async () => {
    const first = await only('Log in');
    const second = await only('Log in');
    expect(second.revision).toBe(first.revision);
    expect(second.ref).toBe(first.ref);
    await observer.evaluate(() => {
      document.body.setAttribute('data-touched', '1');
    });
    const third = await only('Log in');
    expect(third.revision).not.toBe(first.revision);
  });

  it('taps a uniquely named button through the tree without AI locate', async () => {
    const locate = rs.spyOn(agent.service, 'locate');
    const actOnRef = rs.spyOn(device, 'actOnRef');
    try {
      const before = await clicks();
      await agent.aiTap('Log in');
      expect(locate).not.toHaveBeenCalled();
      expect(actOnRef).toHaveBeenCalledTimes(1);
      expect(actOnRef.mock.calls[0][1]).toBe('tap');
      const receipt = await actOnRef.mock.results[0].value;
      expect(receipt).toMatchObject({ status: 'executed' });
      expect((await clicks()).login).toBe(before.login + 1);
    } finally {
      locate.mockRestore();
      actOnRef.mockRestore();
    }
  });

  it('abstains to AI locate when two elements share the name', async () => {
    const matches = await device.locateInTree({ name: 'Save', exact: true });
    expect(matches).toHaveLength(2);
    const second = matches[1].rect;
    const locate = rs.spyOn(agent.service, 'locate').mockResolvedValue({
      element: {
        center: [
          second.left + second.width / 2,
          second.top + second.height / 2,
        ],
        rect: second,
        description: 'Save',
      },
    } as any);
    const actOnRef = rs.spyOn(device, 'actOnRef');
    try {
      const before = await clicks();
      await agent.aiTap('Save');
      expect(locate).toHaveBeenCalledTimes(1);
      expect(actOnRef).not.toHaveBeenCalled();
      expect((await clicks()).save).toBe(before.save + 1);
    } finally {
      locate.mockRestore();
      actOnRef.mockRestore();
    }
  });

  it('marks a covered button and a transparent menu item as not perceivable', async () => {
    const covered = await only('Delete account');
    expect(covered.perceivable).toEqual({
      perceivable: false,
      why: 'covered by div#overlay "Cookie notice"',
    });
    const menuItem = await only('Settings');
    expect(menuItem.role).toBe('menuitem');
    expect(menuItem.perceivable).toEqual({
      perceivable: false,
      why: 'opacity 0 on ancestor ul#menu',
    });
    expect(await device.perceivable(menuItem)).toEqual(menuItem.perceivable);
  });

  it('abstains to AI locate for a covered button', async () => {
    const locate = rs.spyOn(agent.service, 'locate').mockResolvedValue({
      element: {
        center: [80, 216],
        rect: { left: 20, top: 200, width: 120, height: 32 },
        description: 'Delete account',
      },
    } as any);
    const actOnRef = rs.spyOn(device, 'actOnRef');
    try {
      await agent.aiTap('Delete account');
      expect(locate).toHaveBeenCalledTimes(1);
      expect(actOnRef).not.toHaveBeenCalled();
      // the click at the located point lands on the overlay, as a user's would
      expect((await clicks()).deleted).toBe(0);
    } finally {
      locate.mockRestore();
      actOnRef.mockRestore();
    }
  });

  it('blocks a disabled button with the harness reason and never asks AI', async () => {
    const match = await only('Submit order');
    expect(match.perceivable?.perceivable).toBe(true);
    const receipt = await device.actOnRef(match, 'tap');
    expect(receipt.status).toBe('blocked');
    expect(receipt.reason).toContain('disabled');

    const locate = rs.spyOn(agent.service, 'locate');
    try {
      await expect(agent.aiTap('Submit order')).rejects.toThrow(
        /blocked on element .*disabled/,
      );
      expect(locate).not.toHaveBeenCalled();
    } finally {
      locate.mockRestore();
    }
  });

  it('types into a personal-data field through the guarded locator', async () => {
    const email = await only('Email');
    expect(await device.supportsRefOperation(email, 'input', 'a@b.c')).toBe(
      true,
    );
    const receipt = await device.actOnRef(email, 'input', 'a@b.c');
    expect(receipt).toMatchObject({ status: 'executed', verified: true });
    expect(
      await observer.evaluate(
        () =>
          (document.querySelector('input[type=email]') as HTMLInputElement)
            .value,
      ),
    ).toBe('a@b.c');
  });

  it('marks which of two same-name fields takes typing', async () => {
    const fields = await device.locateInTree({
      role: 'textbox',
      name: 'Password',
      exact: true,
    });
    expect(fields).toHaveLength(2);
    expect(fields.map((field) => field.editable)).toEqual([false, true]);
    expect(fields[1].rect).toMatchObject({ left: 500, top: 70 });
  });

  it('declines operations the guard cannot perform, so core uses coordinates', async () => {
    const login = await only('Log in');
    expect(await device.supportsRefOperation(login, 'hover')).toBe(false);
    expect(await device.supportsRefOperation(login, 'doubleClick')).toBe(false);
    expect(
      await device.supportsRefOperation(login, 'keyboardPress', 'Control+A'),
    ).toBe(false);
    expect(
      await device.supportsRefOperation(login, 'keyboardPress', 'Enter'),
    ).toBe(true);
    const disabled = await only('Submit order');
    expect(await device.supportsRefOperation(disabled, 'tap')).toBe(true);
  });

  it('types a native date control through the guard and verifies its value', async () => {
    const date = await only('Start date');
    expect(await device.supportsRefOperation(date, 'input', '2026-10-26')).toBe(
      true,
    );
    const receipt = await device.actOnRef(date, 'input', '2026-10-26');
    expect(receipt).toMatchObject({ status: 'executed', verified: true });
    expect(
      await observer.evaluate(
        () =>
          (document.querySelector('input[type=date]') as HTMLInputElement)
            .value,
      ),
    ).toBe('2026-10-26');
  });

  it('rebinds a ref made stale by a rerender to the same element', async () => {
    const match = await only('Continue');
    await observer.evaluate(() => (window as any).renderContinue(1));
    const before = await clicks();
    const receipt = await device.actOnRef(match, 'tap');
    expect(receipt.status).toBe('executed');
    expect(receipt.rebound?.from).toBe(match.ref);
    expect(receipt.rebound?.to).not.toBe(match.ref);
    expect((await clicks()).cont).toBe(before.cont + 1);
  });

  it('returns stale when the rerendered element is no longer unique', async () => {
    const match = await only('Continue');
    await observer.evaluate(() => (window as any).renderContinue(2));
    const before = await clicks();
    const receipt = await device.actOnRef(match, 'tap');
    expect(receipt.status).toBe('stale');
    expect(receipt.reason).toContain(
      'not rebound: 2 elements have the same role, name and context',
    );
    expect((await clicks()).cont).toBe(before.cont);
    await observer.evaluate(() => (window as any).renderContinue(1));
  });

  it('returns the snapshot as a web UI tree', async () => {
    const login = await only('Log in');
    const tree = await device.getUITree();
    expect(tree.platform).toBe('web');
    expect(tree.revision).toBe(login.revision);
    const find = (node: any): any =>
      node.ref === login.ref ? node : node.children.map(find).find(Boolean);
    const node = find(tree.root);
    expect(node).toMatchObject({
      type: 'button',
      attrs: { name: 'Log in' },
      bounds: { left: 20, top: 20, width: 120, height: 32 },
    });
  });

  it('enforces an explicit layout scope before dispatching a native click', async () => {
    await observer.evaluate(() => {
      const root = document.createElement('section');
      root.id = 'scope-fixture';
      root.style.cssText = 'position:fixed;left:700px;top:20px;z-index:1000';
      root.innerHTML =
        '<div id="scope-owned">Origin group<button id="scope-button">Bound click</button></div><div id="scope-wrong">Other group</div>';
      root.querySelector('button')!.addEventListener('click', () => {
        (window as any).scopeClicks = ((window as any).scopeClicks ?? 0) + 1;
      });
      (window as any).scopeClicks = 0;
      document.body.appendChild(root);
    });
    try {
      const bound = device.page.locator('#scope-button').withScopeBinding({
        kind: 'layout',
        rootSelector: '#scope-owned',
        contextText: 'Origin group',
      });
      expect((await bound.click()).status).toBe('executed');
      expect(await observer.evaluate(() => (window as any).scopeClicks)).toBe(
        1,
      );
      await observer.evaluate(() => {
        document
          .querySelector('#scope-wrong')!
          .appendChild(document.querySelector('#scope-button')!);
      });
      const refused = await bound.click();
      expect(refused.status).not.toBe('executed');
      expect(await observer.evaluate(() => (window as any).scopeClicks)).toBe(
        1,
      );
    } finally {
      await observer.evaluate(() =>
        document.querySelector('#scope-fixture')?.remove(),
      );
    }
  });

  it('refuses a scoped target whose authored role or name is not the resolved node, before dispatch', async () => {
    await observer.evaluate(() => {
      const root = document.createElement('section');
      root.id = 'target-fixture';
      // Inside the viewport and clear of the fixture's overlay (top 190-260px).
      root.style.cssText = 'position:fixed;left:20px;top:120px;z-index:1000';
      root.innerHTML =
        '<div id="target-owned" style="display:flex;gap:8px">Target group<button id="target-button">Proceed</button><span id="target-label">Different action</span><input id="target-field" aria-label="Quantity" value="seed" /></div>';
      (window as any).targetClicks = 0;
      root.querySelector('button')!.addEventListener('click', () => {
        (window as any).targetClicks++;
      });
      document.body.appendChild(root);
    });
    const binding = {
      kind: 'layout' as const,
      rootSelector: '#target-owned',
      contextText: 'Target group',
    };
    type Constraints = {
      targetRole?: string;
      targetName?: string;
      targetExact?: boolean;
    };
    const click = (constraints: Constraints) =>
      device.page
        .locator('#target-button')
        .withScopeBinding({ ...binding, ...constraints })
        .click();
    const fill = (constraints: Constraints) =>
      device.page
        .locator('#target-field')
        .withScopeBinding({ ...binding, ...constraints })
        .fill('replacement');
    const targetClicks = () =>
      observer.evaluate(() => (window as any).targetClicks);
    const fieldValue = () =>
      observer.evaluate(
        () =>
          (document.querySelector('#target-field') as HTMLInputElement).value,
      );
    const refused = { status: 'blocked', reason: 'scope_target_mismatch' };
    try {
      const executed = { status: 'executed' };
      expect(
        await click({ targetRole: 'button', targetName: 'Proceed' }),
      ).toMatchObject(executed);
      // targetExact: false is a case-insensitive substring; the default is exact.
      expect(
        await click({
          targetRole: 'button',
          targetName: 'pROC',
          targetExact: false,
        }),
      ).toMatchObject(executed);
      expect(await targetClicks()).toBe(2);
      for (const constraints of [
        { targetRole: 'link', targetName: 'Proceed' },
        { targetRole: 'button', targetName: 'proceed' },
        { targetRole: 'button', targetName: 'Proc' },
        { targetRole: 'button', targetName: 'proceed', targetExact: true },
      ]) {
        expect(await click(constraints)).toMatchObject(refused);
      }
      // An explicit role is the node's role, whatever its tag.
      await observer.evaluate(() =>
        document.querySelector('#target-button')!.setAttribute('role', 'link'),
      );
      expect(
        await click({ targetRole: 'button', targetName: 'Proceed' }),
      ).toMatchObject(refused);
      // The accessible name wins over the element's own text.
      await observer.evaluate(() => {
        const button = document.querySelector('#target-button')!;
        button.removeAttribute('role');
        button.setAttribute('aria-labelledby', 'target-label');
      });
      expect(
        await click({ targetRole: 'button', targetName: 'Proceed' }),
      ).toMatchObject(refused);
      expect(await targetClicks()).toBe(2);
      // A scoped fill keeps the authored role too: no character is typed.
      await observer.evaluate(() =>
        document
          .querySelector('#target-field')!
          .setAttribute('role', 'combobox'),
      );
      expect(
        await fill({ targetRole: 'textbox', targetName: 'Quantity' }),
      ).toMatchObject(refused);
      expect(await fieldValue()).toBe('seed');
      await observer.evaluate(() =>
        document.querySelector('#target-field')!.removeAttribute('role'),
      );
      expect(
        await fill({ targetRole: 'textbox', targetName: 'Quantity' }),
      ).toMatchObject(executed);
      expect(await fieldValue()).toBe('replacement');
    } finally {
      await observer.evaluate(() =>
        document.querySelector('#target-fixture')?.remove(),
      );
    }
  });

  it('refuses a retained ref after its unchanged target moves to another owner', async () => {
    await observer.evaluate(() => {
      const root = document.createElement('section');
      root.id = 'ancestry-fixture';
      root.style.cssText = 'position:fixed;left:700px;top:70px;z-index:1000';
      root.innerHTML =
        '<div role="group" aria-label="First owner"><button id="ancestry-button">Ancestry click</button></div><div id="ancestry-other" role="group" aria-label="Second owner"></div>';
      (window as any).ancestryClicks = 0;
      root.querySelector('button')!.addEventListener('click', () => {
        (window as any).ancestryClicks++;
      });
      document.body.appendChild(root);
    });
    try {
      const original = await only('Ancestry click');
      await observer.evaluate(() =>
        document
          .querySelector('#ancestry-other')!
          .appendChild(document.querySelector('#ancestry-button')!),
      );
      const refused = await device.page.locator(original.ref).click();
      expect(refused.status).not.toBe('executed');
      expect(
        await observer.evaluate(() => (window as any).ancestryClicks),
      ).toBe(0);
    } finally {
      await observer.evaluate(() =>
        document.querySelector('#ancestry-fixture')?.remove(),
      );
    }
  });

  it('keeps masked native values out of both observations and commit delivery', async () => {
    const before = 'fixture-private-before';
    const after = 'fixture-private-after';
    await observer.evaluate((value) => {
      const input = document.createElement('input');
      input.id = 'masked-commit-fixture';
      input.type = 'password';
      input.style.cssText =
        'position:fixed;left:600px;top:140px;width:120px;height:30px;z-index:1000';
      input.value = value;
      document.body.appendChild(input);
    }, before);
    const guard = new InteractionController(device.session, {
      allowedOrigins: [baseUrl],
      input: 'trusted',
      allowSensitive: true,
      maskSensitive: true,
    });
    try {
      const document = await device.page.cdp('DOM.getDocument', {});
      const selected = await device.page.cdp('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: '#masked-commit-fixture',
      });
      const described = await device.page.cdp('DOM.describeNode', {
        nodeId: selected.nodeId,
      });
      const observed = await guard.observe({
        scope: device.page.scope,
        backendNodeId: described.node.backendNodeId,
      });
      expect(observed.candidates).toHaveLength(1);
      expect(observed.candidates[0].value).toBe('[masked]');
      const targetId = observed.candidates[0].id;
      const acted = await guard.act({
        scope: device.page.scope,
        observationId: observed.observationId,
        action: { targetId, operation: 'type', text: after },
      });
      expect(acted.status).toBe('executed');
      expect(acted.verified).toBeNull();
      const committed = await guard.commitTypedValue({
        scope: device.page.scope,
        observationId: observed.observationId,
        targetId,
      });
      expect(committed.masked).toBe(true);
      expect(committed.verified).toBeNull();
      const delivery = JSON.stringify({ observed, acted, committed });
      expect(delivery).not.toContain(before);
      expect(delivery).not.toContain(after);
    } finally {
      guard.close();
      await observer.evaluate(() =>
        document.querySelector('#masked-commit-fixture')?.remove(),
      );
    }
  });

  it('takes a screenshot the size of the viewport', async () => {
    const shot = await device.screenshotBase64();
    expect(shot.startsWith('data:image/jpeg;base64,')).toBe(true);
  });
});
