/**
 * Typing the way a person does, for hosts that drive browser-harness-js over raw CDP: select-all with the platform's
 * modifier, then one key per character. Ported from the flow-runner pilot's patched browser-harness-js
 * (driver-codemode src/vendor/bhjs/interaction.ts); it lives outside vendor/ so that directory stays byte-identical
 * with upstream, and moves into it once browser-harness-js exports these.
 */

type Send = (method: string, params: unknown) => Promise<unknown>;

/** Select all: Cmd+A on macOS, Ctrl+A elsewhere (CDP modifier bits: Control 2, Meta 4); the selectAll command backs it up. */
export const SELECT_ALL_MODIFIER = process.platform === 'darwin' ? 4 : 2;

const SHIFTED: Record<string, string> = {
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
};

const PUNCTUATION: Record<string, { code: string; keyCode: number }> = {
  '`': { code: 'Backquote', keyCode: 192 },
  '-': { code: 'Minus', keyCode: 189 },
  '=': { code: 'Equal', keyCode: 187 },
  '[': { code: 'BracketLeft', keyCode: 219 },
  ']': { code: 'BracketRight', keyCode: 221 },
  '\\': { code: 'Backslash', keyCode: 220 },
  ';': { code: 'Semicolon', keyCode: 186 },
  "'": { code: 'Quote', keyCode: 222 },
  ',': { code: 'Comma', keyCode: 188 },
  '.': { code: 'Period', keyCode: 190 },
  '/': { code: 'Slash', keyCode: 191 },
  ' ': { code: 'Space', keyCode: 32 },
};

/** The US-keyboard key that types a character, or null when no single key does (then it is inserted as text, like an IME). */
function keyFor(
  ch: string,
): { code: string; keyCode: number; shift: boolean } | null {
  if (/^[a-z]$/.test(ch)) {
    return {
      code: `Key${ch.toUpperCase()}`,
      keyCode: ch.toUpperCase().charCodeAt(0),
      shift: false,
    };
  }
  if (/^[A-Z]$/.test(ch)) {
    return { code: `Key${ch}`, keyCode: ch.charCodeAt(0), shift: true };
  }
  if (/^[0-9]$/.test(ch)) {
    return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0), shift: false };
  }
  const base = SHIFTED[ch];
  if (base) {
    const key = /^[0-9]$/.test(base)
      ? { code: `Digit${base}`, keyCode: base.charCodeAt(0) }
      : PUNCTUATION[base]!;
    return { ...key, shift: true };
  }
  return PUNCTUATION[ch] ? { ...PUNCTUATION[ch]!, shift: false } : null;
}

/** One keydown (with its text, so keypress and input follow) and keyup per character. */
export async function typeKeys(send: Send, text: string): Promise<void> {
  for (const ch of text) {
    const key = keyFor(ch);
    if (!key) {
      await send('Input.insertText', { text: ch });
      continue;
    }
    const fields = {
      key: ch,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      ...(key.shift ? { modifiers: 8 } : {}),
    };
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      ...fields,
      text: ch,
      unmodifiedText: ch,
    });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...fields });
  }
}
