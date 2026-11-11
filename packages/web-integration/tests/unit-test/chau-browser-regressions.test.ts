import { runInNewContext } from 'node:vm';
import {
  Page,
  foldedPopupOf,
  forceClosePopup,
  setKeepPopups,
} from '@/puppeteer/base-page';
import { getKeyCommands, resolveNavigateUrl } from '@/web-page';
import { describe, expect, it, rs } from '@rstest/core';

function popupFixture() {
  let listener: (popup: any) => Promise<void>;
  const page = {
    on: rs.fn((_event, callback) => {
      listener = callback;
    }),
    url: () => 'https://app.example/start',
    isClosed: () => false,
    goto: rs.fn().mockResolvedValue(undefined),
  };
  const popup = {
    url: () => 'https://mail.example/code',
    isClosed: () => false,
    close: rs.fn().mockResolvedValue(undefined),
  };
  forceClosePopup(page as any, rs.fn() as any);
  return { page, popup, emit: () => listener(popup) };
}

describe('Chau browser ports', () => {
  it.each(['c', 'C', '!', '1'])('preserves the lone key %s', (key) => {
    expect(getKeyCommands(key)).toEqual([{ key }]);
  });
  it('retains explicit modifier combinations', () => {
    expect(getKeyCommands(['Control', 'c'])).toEqual([
      { key: 'Control' },
      { key: 'C', command: 'Copy' },
    ]);
  });
  it('resolves relative navigation without inventing an origin', async () => {
    const page = { url: async () => 'https://app.example/orders/1' };
    expect(await resolveNavigateUrl(page, ' /help ')).toBe(
      'https://app.example/help',
    );
    expect(await resolveNavigateUrl(page, '../2')).toBe(
      'https://app.example/2',
    );
    expect(await resolveNavigateUrl(page, 'https://other.example/path')).toBe(
      'https://other.example/path',
    );
    await expect(
      resolveNavigateUrl({ url: async () => 'about:blank' }, '/help'),
    ).rejects.toThrow('full URL');
  });
  it('keeps only the opted-in parent’s popups and supports opting out', async () => {
    const kept = popupFixture();
    const folded = popupFixture();
    setKeepPopups(kept.page as any, true);
    await kept.emit();
    expect(kept.popup.close).not.toHaveBeenCalled();
    expect(kept.page.goto).not.toHaveBeenCalled();
    expect(foldedPopupOf(kept.page as any)).toBeUndefined();
    await folded.emit();
    expect(folded.popup.close).toHaveBeenCalledTimes(1);
    expect(foldedPopupOf(folded.page as any)).toEqual({
      from: 'https://app.example/start',
      to: 'https://mail.example/code',
    });
    setKeepPopups(kept.page as any, false);
    await kept.emit();
    expect(kept.popup.close).toHaveBeenCalledTimes(1);
  });
  it('does not record a popup fold whose navigation failed', async () => {
    const { page, emit } = popupFixture();
    page.goto.mockRejectedValueOnce(new Error('navigation failed'));
    await emit();
    expect(foldedPopupOf(page as any)).toBeUndefined();
  });
  it.each(['puppeteer', 'playwright'] as const)(
    'stabilizes root overscroll before %s wheel input',
    async (kind) => {
      const calls: string[] = [];
      const underlying = {
        evaluate: rs.fn(async (script: unknown) => {
          expect(String(script)).toContain('overscrollBehavior');
          calls.push('stabilize');
        }),
        mouse: {
          move: rs.fn(async () => {
            calls.push('move');
          }),
          wheel: rs.fn(async () => {
            calls.push('wheel');
          }),
        },
      };
      await new Page(underlying as any, kind).scrollUntilTop({
        left: 10,
        top: 20,
      });
      expect(calls).toEqual(['stabilize', 'move', 'wheel']);
    },
  );
  it.each(['puppeteer', 'playwright'] as const)(
    'preserves explicit per-axis overscroll policies for %s',
    async (kind) => {
      const root = {
        style: {},
        computed: {
          overscrollBehaviorX: 'contain',
          overscrollBehaviorY: 'auto',
        },
      };
      const body = {
        style: {},
        computed: { overscrollBehaviorX: 'auto', overscrollBehaviorY: 'none' },
      };
      const underlying = {
        evaluate: rs.fn(async (script: unknown) =>
          runInNewContext(String(script), {
            document: { documentElement: root, body },
            getComputedStyle: (element: typeof root) => element.computed,
          }),
        ),
        mouse: { move: rs.fn(), wheel: rs.fn() },
      };
      await new Page(underlying as any, kind).scrollUntilBottom({
        left: 10,
        top: 20,
      });
      expect(root.style).toEqual({ overscrollBehaviorY: 'none' });
      expect(body.style).toEqual({ overscrollBehaviorX: 'none' });
    },
  );
  it('still scrolls when the overscroll probe is unavailable', async () => {
    const underlying = {
      evaluate: rs.fn().mockRejectedValue(new Error('frame detached')),
      mouse: { move: rs.fn(), wheel: rs.fn() },
    };
    await new Page(underlying as any, 'puppeteer').scrollUntilBottom({
      left: 10,
      top: 20,
    });
    expect(underlying.mouse.wheel).toHaveBeenCalledTimes(1);
  });
});
