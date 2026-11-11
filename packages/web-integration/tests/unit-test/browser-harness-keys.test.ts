import { describe, expect, it } from '@rstest/core';
import {
  Browser,
  SELECT_ALL_MODIFIER,
  typeKeys,
} from '../../src/browser-harness';

describe('browser-harness typing exports', () => {
  it('resolve from the browser-harness entry, next to Browser', () => {
    expect(typeof Browser).toBe('function');
    expect(typeof typeKeys).toBe('function');
    expect(SELECT_ALL_MODIFIER).toBe(process.platform === 'darwin' ? 4 : 2);
  });

  it('types one keydown and keyup per character, with shift for capitals and text for keys a US keyboard lacks', async () => {
    const sent: Array<[string, any]> = [];
    await typeKeys(async (method, params) => {
      sent.push([method, params]);
    }, 'aB!é');
    expect(
      sent.map(([method, params]) => [
        method,
        params.type,
        params.key ?? params.text,
      ]),
    ).toEqual([
      ['Input.dispatchKeyEvent', 'keyDown', 'a'],
      ['Input.dispatchKeyEvent', 'keyUp', 'a'],
      ['Input.dispatchKeyEvent', 'keyDown', 'B'],
      ['Input.dispatchKeyEvent', 'keyUp', 'B'],
      ['Input.dispatchKeyEvent', 'keyDown', '!'],
      ['Input.dispatchKeyEvent', 'keyUp', '!'],
      ['Input.insertText', undefined, 'é'],
    ]);
    expect(sent[2]![1]).toMatchObject({ code: 'KeyB', modifiers: 8 });
    expect(sent[4]![1]).toMatchObject({ code: 'Digit1', modifiers: 8 });
  });

  it('commits characters no key types whole, one grapheme at a time: Japanese, Vietnamese, emoji', async () => {
    const inserted = async (text: string) => {
      const sent: Array<[string, any]> = [];
      await typeKeys(async (method, params) => {
        sent.push([method, params]);
      }, text);
      return sent
        .filter(([method]) => method === 'Input.insertText')
        .map(([, params]) => params.text);
    };
    expect(await inserted('東京')).toEqual(['東', '京']);
    expect(await inserted('Việt Nam')).toEqual(['ệ']);
    // Decomposed tone marks stay with their letter.
    expect(await inserted('Vie\u0302\u0323t')).toEqual(['e\u0302\u0323']);
    expect(await inserted('👩‍👩‍👧')).toEqual(['👩‍👩‍👧']);
  });
});
