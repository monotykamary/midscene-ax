import { InteractionController, snapshotAncestry } from '@/browser-harness';
import { describe, expect, it } from '@rstest/core';
import type { AXNode } from '../../src/browser-harness/vendor/bhjs/snapshot';

const node = (
  nodeId: string,
  role: string,
  extra: Partial<AXNode> = {},
): AXNode => ({
  nodeId,
  ignored: false,
  role: { type: 'role', value: role },
  ...extra,
});
describe('published guarded scope API', () => {
  it('exports the native controller and rejects invalid scopes before transport', async () => {
    let calls = 0;
    const guard = new InteractionController(
      {
        _call: async () => {
          calls++;
          throw new Error('unexpected transport');
        },
      },
      { allowedOrigins: ['https://example.test'] },
    );
    try {
      await expect(
        guard.observe({
          scope: { sessionId: 'test' },
          backendNodeId: 1,
          scopeBinding: { kind: 'identity', rootBackendNodeId: 0 },
        }),
      ).rejects.toThrow('Invalid scope binding');
      expect(calls).toBe(0);
    } finally {
      guard.close();
    }
  });
  it('binds stable authored ancestry and detects a same-target owner change', () => {
    const owner = node('owner', 'group', {
      backendDOMNodeId: 10,
      childIds: ['target'],
      name: {
        type: 'computedString',
        value: 'Authored group',
        sources: [
          {
            type: 'attribute',
            attribute: 'aria-label',
            value: { type: 'string', value: 'Authored group' },
          },
        ],
      },
    });
    const target = node('target', 'button', { backendDOMNodeId: 11 });
    const first = snapshotAncestry([owner, target])(target);
    expect(first.scopeBinding).toEqual({
      kind: 'semantic',
      rootBackendNodeId: 10,
      role: 'group',
      name: 'Authored group',
    });
    const changed = snapshotAncestry([
      { ...owner, backendDOMNodeId: 20 },
      target,
    ])(target);
    expect(changed.ancestorIdentity).not.toBe(first.ancestorIdentity);
  });
  it('refuses cyclic ancestry rather than issuing a binding', () => {
    const a = node('a', 'group', { childIds: ['b'] });
    const b = node('b', 'button', { childIds: ['a'] });
    expect(() => snapshotAncestry([a, b])(b)).toThrow('AX ancestry cycle');
  });
});
