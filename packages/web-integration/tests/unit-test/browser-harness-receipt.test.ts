import {
  MAX_RECEIPT_DIFF_CHARS,
  guardOperationFor,
  harnessCallFor,
  toActReceipt,
} from '@/browser-harness/receipt';
import {
  type HarnessRefEntry,
  matchEntries,
  parseSnapshotTree,
} from '@/browser-harness/tree';
import { describe, expect, it } from '@rstest/core';

describe('browser-harness receipt mapping', () => {
  it('maps an executed action with its diff and revision', () => {
    expect(
      toActReceipt({
        status: 'executed',
        reason: 'dispatched_not_verified',
        verified: null,
        snapshot: { id: 'snap-2', diff: '- button "Open"\n+ dialog "Menu"' },
      }),
    ).toEqual({
      status: 'executed',
      verified: null,
      reason: 'dispatched_not_verified',
      diff: '- button "Open"\n+ dialog "Menu"',
      revision: 'snap-2',
    });
  });

  it('keeps a verified read-back as returned', () => {
    expect(toActReceipt({ status: 'executed', verified: true }).verified).toBe(
      true,
    );
    expect(toActReceipt({ status: 'executed', verified: false }).verified).toBe(
      false,
    );
  });

  it('keeps the harness blocked reason verbatim', () => {
    const reason =
      'not_interactable_or_unsupported: covered at its centre by div#cookie "Accept". Close or move what covers it, then retry';
    expect(toActReceipt({ status: 'blocked', reason, verified: null })).toEqual(
      { status: 'blocked', verified: null, reason },
    );
  });

  it('never reports an unknown outcome as verified', () => {
    expect(
      toActReceipt({
        status: 'outcome_unknown',
        reason: 'changed_during_dispatch',
        verified: true,
      }),
    ).toEqual({
      status: 'outcome_unknown',
      verified: null,
      reason: 'changed_during_dispatch',
    });
  });

  it('appends a failed read-back and a rebind note to the reason', () => {
    expect(
      toActReceipt({
        status: 'executed',
        reason: 'dispatched_not_verified',
        verified: null,
        verificationError: 'Snapshot exceeds 50000 characters',
      }).reason,
    ).toBe(
      'dispatched_not_verified; verification read failed: Snapshot exceeds 50000 characters',
    );
    expect(
      toActReceipt(
        {
          status: 'stale',
          reason: 'stale_ref: target changed',
          verified: null,
        },
        {
          rebindNote:
            'not rebound: 2 elements have the same role, name and context',
        },
      ),
    ).toEqual({
      status: 'stale',
      verified: null,
      reason:
        'stale_ref: target changed; not rebound: 2 elements have the same role, name and context',
    });
  });

  it('reports a rebound ref', () => {
    expect(
      toActReceipt(
        { status: 'executed', verified: null },
        { rebound: { from: 'sAAAAAAAAAAAA_1e3', to: 'sAAAAAAAAAAAA_2e3' } },
      ).rebound,
    ).toEqual({ from: 'sAAAAAAAAAAAA_1e3', to: 'sAAAAAAAAAAAA_2e3' });
  });

  it('cuts long diffs', () => {
    const receipt = toActReceipt({
      status: 'executed',
      verified: null,
      snapshot: { id: 's', diff: 'x'.repeat(MAX_RECEIPT_DIFF_CHARS + 10) },
    });
    expect(receipt.diff).toBe(
      `${'x'.repeat(MAX_RECEIPT_DIFF_CHARS)}\n[diff truncated: 10 more characters]`,
    );
  });

  it('rejects a status outside the contract', () => {
    expect(() =>
      toActReceipt({ status: 'done' as any, verified: null }),
    ).toThrow('unknown action status');
  });
});

describe('browser-harness operations', () => {
  it('maps ref operations to guarded locator calls', () => {
    expect(harnessCallFor('tap')).toEqual({ method: 'click' });
    expect(harnessCallFor('input', 'hello')).toEqual({
      method: 'fill',
      text: 'hello',
    });
    expect(harnessCallFor('clear')).toEqual({ method: 'fill', text: '' });
    expect(harnessCallFor('keyboardPress', 'Enter')).toEqual({
      method: 'press',
      key: 'Enter',
    });
    expect(harnessCallFor('select', 'Blue')).toEqual({
      method: 'selectOption',
      option: 'Blue',
    });
    expect(harnessCallFor('scrollIntoView')).toEqual({
      method: 'scrollIntoView',
    });
  });

  it('has no guarded form for pointer-only operations or unlisted keys', () => {
    expect(harnessCallFor('doubleClick')).toBeUndefined();
    expect(harnessCallFor('rightClick')).toBeUndefined();
    expect(harnessCallFor('hover')).toBeUndefined();
    expect(harnessCallFor('keyboardPress', 'Control+A')).toBeUndefined();
    expect(harnessCallFor('input')).toBeUndefined();
  });

  it('names the guard operation each call needs', () => {
    expect(guardOperationFor({ method: 'fill', text: '' })).toBe('type');
    expect(guardOperationFor({ method: 'press', key: 'Tab' })).toBe('press');
  });
});

describe('browser-harness tree matching', () => {
  const entry = (
    ref: string,
    role: string,
    name: string,
    context?: string,
  ): HarnessRefEntry => ({
    ref,
    role,
    name,
    ...(context ? { context } : {}),
    backendNodeId: 1,
    frameId: 'F',
    sessionId: 'S',
    mainFrame: true,
  });
  const entries = [
    entry('r0', 'RootWebArea', 'Log in'),
    entry('r1', 'heading', 'Welcome back'),
    entry('r2', 'button', 'Log in'),
    entry('r3', 'button', 'Log  in ', 'dialog: Session expired'),
    entry('r4', 'link', 'Log in with SSO'),
  ];

  it('matches exact names after whitespace normalisation, never the document', () => {
    expect(
      matchEntries(entries, { name: 'Log in', exact: true }).map((e) => e.ref),
    ).toEqual(['r2', 'r3']);
  });

  it('narrows by role and context', () => {
    expect(
      matchEntries(entries, {
        role: 'BUTTON',
        name: 'Log in',
        exact: true,
        context: 'dialog: Session expired',
      }).map((e) => e.ref),
    ).toEqual(['r3']);
    expect(
      matchEntries(entries, { role: 'link', name: 'Log in', exact: true }),
    ).toEqual([]);
  });

  it('matches substrings only when the query is not exact', () => {
    expect(matchEntries(entries, { name: 'log in' }).map((e) => e.ref)).toEqual(
      ['r2', 'r3', 'r4'],
    );
  });

  it('matches a ref', () => {
    expect(matchEntries(entries, { ref: 'r4' }).map((e) => e.ref)).toEqual([
      'r4',
    ]);
  });

  it('parses a snapshot tree into UI nodes', () => {
    const tree = [
      'url: "http://127.0.0.1/"',
      '- RootWebArea "Fixture" [ref=sAAAAAAAAAAAA_1e1]',
      '  - main [ref=sAAAAAAAAAAAA_1e2]',
      '    - button "Log in" [ref=sAAAAAAAAAAAA_1e3] [disabled]',
      '    - textbox "Email" [ref=sAAAAAAAAAAAA_1e4] [focused] value="a@b.c"',
      '    - text: "Hello"',
      '  - checkbox "Remember" [ref=sAAAAAAAAAAAA_1e5] [checked=true]',
    ].join('\n');
    const box = { left: 1, top: 2, width: 3, height: 4 };
    const [root] = parseSnapshotTree(tree, (ref) =>
      ref === 'sAAAAAAAAAAAA_1e3' ? box : undefined,
    );
    expect(root.type).toBe('RootWebArea');
    expect(root.attrs.name).toBe('Fixture');
    expect(root.children.map((c) => c.type)).toEqual(['main', 'checkbox']);
    const [button, textbox, text] = root.children[0].children;
    expect(button).toMatchObject({
      type: 'button',
      ref: 'sAAAAAAAAAAAA_1e3',
      bounds: box,
      attrs: { name: 'Log in', disabled: 'true', ref: 'sAAAAAAAAAAAA_1e3' },
    });
    expect(textbox.attrs).toMatchObject({
      name: 'Email',
      focused: 'true',
      value: 'a@b.c',
    });
    expect(text).toMatchObject({ type: 'text', attrs: { name: 'Hello' } });
    expect(root.children[1].attrs.checked).toBe('true');
  });
});
