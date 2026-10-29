import type { Point } from '@midscene/core';
import { z } from '@midscene/core';
import {
  AbstractInterface,
  type BrowserInputPrimitives,
  type DeviceAction,
  type InputStrategy,
  defineAction,
  defineActionsFromInputPrimitives,
  resolveTextInputOptions,
  sendTextSequentially,
} from '@midscene/core/device';

import { sleep } from '@midscene/core/utils';
import type { ElementInfo } from '@midscene/shared/extractor';
import { getDebug } from '@midscene/shared/logger';
import { transformHotkeyInput } from '@midscene/shared/us-keyboard-layout';

const navigateParamSchema = z.object({
  url: z
    .string()
    .describe(
      'The URL to navigate to. Must start with https://, file://, or a similar protocol.',
    ),
});

function normalizeKeyInputs(value: string | string[]): string[] {
  const inputs = Array.isArray(value) ? value : [value];
  const result: string[] = [];

  for (const input of inputs) {
    if (typeof input !== 'string') {
      result.push(input as unknown as string);
      continue;
    }

    const trimmed = input.trim();
    if (!trimmed) {
      result.push(input);
      continue;
    }

    let normalized = trimmed;
    if (normalized.length > 1 && normalized.includes('+')) {
      normalized = normalized.replace(/\s*\+\s*/g, ' ');
    }
    if (/\s/.test(normalized)) {
      normalized = normalized.replace(/\s+/g, ' ');
    }

    const transformed = transformHotkeyInput(normalized);
    if (transformed.length === 1 && transformed[0] === '' && trimmed !== '') {
      result.push(input);
      continue;
    }
    if (transformed.length === 0) {
      result.push(input);
      continue;
    }

    result.push(...transformed);
  }

  return result;
}

export function getKeyCommands(
  value: string | string[],
): Array<{ key: string; command?: string }> {
  const keys = normalizeKeyInputs(value);

  return keys.reduce((acc: Array<{ key: string; command?: string }>, k) => {
    const includeMeta = keys.includes('Meta') || keys.includes('Control');
    if (includeMeta && (k === 'a' || k === 'A')) {
      return acc.concat([{ key: k, command: 'SelectAll' }]);
    }
    if (includeMeta && (k === 'c' || k === 'C')) {
      return acc.concat([{ key: k, command: 'Copy' }]);
    }
    if (includeMeta && (k === 'v' || k === 'V')) {
      return acc.concat([{ key: k, command: 'Paste' }]);
    }
    return acc.concat([{ key: k }]);
  }, []);
}

// this is copied from puppeteer, but we don't want to import puppeteer here
export declare type KeyInput =
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'Power'
  | 'Eject'
  | 'Abort'
  | 'Help'
  | 'Backspace'
  | 'Tab'
  | 'Numpad5'
  | 'NumpadEnter'
  | 'Enter'
  | '\r'
  | '\n'
  | 'ShiftLeft'
  | 'ShiftRight'
  | 'ControlLeft'
  | 'ControlRight'
  | 'AltLeft'
  | 'AltRight'
  | 'Pause'
  | 'CapsLock'
  | 'Escape'
  | 'Convert'
  | 'NonConvert'
  | 'Space'
  | 'Numpad9'
  | 'PageUp'
  | 'Numpad3'
  | 'PageDown'
  | 'End'
  | 'Numpad1'
  | 'Home'
  | 'Numpad7'
  | 'ArrowLeft'
  | 'Numpad4'
  | 'Numpad8'
  | 'ArrowUp'
  | 'ArrowRight'
  | 'Numpad6'
  | 'Numpad2'
  | 'ArrowDown'
  | 'Select'
  | 'Open'
  | 'PrintScreen'
  | 'Insert'
  | 'Numpad0'
  | 'Delete'
  | 'NumpadDecimal'
  | 'Digit0'
  | 'Digit1'
  | 'Digit2'
  | 'Digit3'
  | 'Digit4'
  | 'Digit5'
  | 'Digit6'
  | 'Digit7'
  | 'Digit8'
  | 'Digit9'
  | 'KeyA'
  | 'KeyB'
  | 'KeyC'
  | 'KeyD'
  | 'KeyE'
  | 'KeyF'
  | 'KeyG'
  | 'KeyH'
  | 'KeyI'
  | 'KeyJ'
  | 'KeyK'
  | 'KeyL'
  | 'KeyM'
  | 'KeyN'
  | 'KeyO'
  | 'KeyP'
  | 'KeyQ'
  | 'KeyR'
  | 'KeyS'
  | 'KeyT'
  | 'KeyU'
  | 'KeyV'
  | 'KeyW'
  | 'KeyX'
  | 'KeyY'
  | 'KeyZ'
  | 'MetaLeft'
  | 'MetaRight'
  | 'ContextMenu'
  | 'NumpadMultiply'
  | 'NumpadAdd'
  | 'NumpadSubtract'
  | 'NumpadDivide'
  | 'F1'
  | 'F2'
  | 'F3'
  | 'F4'
  | 'F5'
  | 'F6'
  | 'F7'
  | 'F8'
  | 'F9'
  | 'F10'
  | 'F11'
  | 'F12'
  | 'F13'
  | 'F14'
  | 'F15'
  | 'F16'
  | 'F17'
  | 'F18'
  | 'F19'
  | 'F20'
  | 'F21'
  | 'F22'
  | 'F23'
  | 'F24'
  | 'NumLock'
  | 'ScrollLock'
  | 'AudioVolumeMute'
  | 'AudioVolumeDown'
  | 'AudioVolumeUp'
  | 'MediaTrackNext'
  | 'MediaTrackPrevious'
  | 'MediaStop'
  | 'MediaPlayPause'
  | 'Semicolon'
  | 'Equal'
  | 'NumpadEqual'
  | 'Comma'
  | 'Minus'
  | 'Period'
  | 'Slash'
  | 'Backquote'
  | 'BracketLeft'
  | 'Backslash'
  | 'BracketRight'
  | 'Quote'
  | 'AltGraph'
  | 'Props'
  | 'Cancel'
  | 'Clear'
  | 'Shift'
  | 'Control'
  | 'Alt'
  | 'Accept'
  | 'ModeChange'
  | ' '
  | 'Print'
  | 'Execute'
  | '\u0000'
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z'
  | 'Meta'
  | '*'
  | '+'
  | '-'
  | '/'
  | ';'
  | '='
  | ','
  | '.'
  | '`'
  | '['
  | '\\'
  | ']'
  | "'"
  | 'Attn'
  | 'CrSel'
  | 'ExSel'
  | 'EraseEof'
  | 'Play'
  | 'ZoomOut'
  | ')'
  | '!'
  | '@'
  | '#'
  | '$'
  | '%'
  | '^'
  | '&'
  | '('
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z'
  | ':'
  | '<'
  | '_'
  | '>'
  | '?'
  | '~'
  | '{'
  | '|'
  | '}'
  | '"'
  | 'SoftLeft'
  | 'SoftRight'
  | 'Camera'
  | 'Call'
  | 'EndCall'
  | 'VolumeDown'
  | 'VolumeUp';

export type MouseButton = 'left' | 'right' | 'middle';

export interface MouseAction {
  click: (
    x: number,
    y: number,
    options: { button: MouseButton; count?: number },
  ) => Promise<void>;
  wheel: (deltaX: number, deltaY: number) => Promise<void>;
  move: (x: number, y: number) => Promise<void>;
  drag: (
    from: { x: number; y: number },
    to: { x: number; y: number },
  ) => Promise<void>;
}

export interface KeyboardAction {
  type: (text: string, options?: { delay?: number }) => Promise<void>;
  insertText: (text: string) => Promise<void>;
  press: (
    action:
      | { key: KeyInput; command?: string }
      | { key: KeyInput; command?: string }[],
  ) => Promise<void>;
}

export interface ChromePageDestroyOptions {
  closeTab?: boolean; // should close the tab when the page object is destroyed
}

export abstract class AbstractWebPage extends AbstractInterface {
  readonly keyboardTypeDelay?: number;
  readonly inputStrategy?: InputStrategy;
  navigate?(url: string): Promise<void>;
  reload?(): Promise<void>;
  goBack?(): Promise<void>;
  goForward?(): Promise<void>;
  stopLoading?(): Promise<void>;
  navigationState?(): Promise<{ isLoading: boolean }>;
  flushPendingVisualUpdate?(force?: boolean): Promise<void>;
  schedulePendingVisualUpdate?(force?: boolean): void;
  waitForDomQuiet?(opts?: {
    quietMs?: number;
    timeoutMs?: number;
    target?: ElementInfo;
  }): Promise<void>;
  /**
   * Whether native date inputs show the day before the month, as the browser
   * draws them. Undefined when the page cannot tell.
   */
  dateFieldsDayFirst?(): Promise<boolean | undefined>;
  /**
   * Calendar dates (YYYY-MM-DD) the current step names. When digits typed
   * into a date field read as two different dates, the one named here wins.
   */
  dateHints?: string[];

  get mouse(): MouseAction {
    return {
      click: async (
        x: number,
        y: number,
        options: { button: MouseButton },
      ) => {},
      wheel: async (deltaX: number, deltaY: number) => {},
      move: async (x: number, y: number) => {},
      drag: async (
        from: { x: number; y: number },
        to: { x: number; y: number },
      ) => {},
    };
  }

  get keyboard(): KeyboardAction {
    return {
      type: async (text: string, options?: { delay?: number }) => {},
      insertText: async (text: string) => {},
      press: async (
        action:
          | { key: KeyInput; command?: string }
          | { key: KeyInput; command?: string }[],
      ) => {},
    };
  }

  async clearInput(element?: ElementInfo): Promise<void> {}

  async selectAllInput(element?: ElementInfo): Promise<void> {
    throw new Error('Bulk text input is not supported by this web page');
  }

  abstract scrollUntilTop(startingPoint?: Point): Promise<void>;
  abstract scrollUntilBottom(startingPoint?: Point): Promise<void>;
  abstract scrollUntilLeft(startingPoint?: Point): Promise<void>;
  abstract scrollUntilRight(startingPoint?: Point): Promise<void>;
  abstract scrollUp(distance?: number, startingPoint?: Point): Promise<void>;
  abstract scrollDown(distance?: number, startingPoint?: Point): Promise<void>;
  abstract scrollLeft(distance?: number, startingPoint?: Point): Promise<void>;
  abstract scrollRight(distance?: number, startingPoint?: Point): Promise<void>;
  abstract longPress(x: number, y: number, duration?: number): Promise<void>;
  abstract swipe(
    from: { x: number; y: number },
    to: { x: number; y: number },
    duration?: number,
  ): Promise<void>;
  abstract pinch(
    centerX: number,
    centerY: number,
    startDistance: number,
    endDistance: number,
    duration?: number,
  ): Promise<void>;
}

const scheduleWebVisualUpdate = (
  page: AbstractWebPage,
  force = false,
): void => {
  if (page.schedulePendingVisualUpdate) {
    if (force) {
      page.schedulePendingVisualUpdate(true);
    } else {
      page.schedulePendingVisualUpdate();
    }
    return;
  }

  const pendingRefresh = force
    ? page.flushPendingVisualUpdate?.(true)
    : page.flushPendingVisualUpdate?.();
  void pendingRefresh?.catch(() => undefined);
};

// Native date and time inputs draw their own segmented editor (mm/dd/yyyy in
// en-US). Keystrokes land segment by segment, and an ISO value typed into one
// came out as "10/11/0002": the year digits spilled into the day and the
// month. When the located field is one of these inputs, convert the value to
// the format the input's `value` takes and set it the way a user's pick does
// — the native setter, then `input` and `change` — instead of typing. Any
// value it cannot read falls back to typing.
const debugTypeText = getDebug('web:type-text');

const NATIVE_TEMPORAL_INPUT = `((x, y, raw, shownDayFirst, hints) => {
  let el = document.elementFromPoint(x, y);
  for (let i = 0; i < 5 && el && el.shadowRoot; i++) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (el && el.tagName === 'LABEL' && el.control) el = el.control;
  if (!el || el.tagName !== 'INPUT') return null;
  const type = (el.type || '').toLowerCase();
  if (!['date', 'time', 'datetime-local', 'month', 'week'].includes(type)) return null;
  const v = String(raw).trim();
  const pad = (n) => String(n).padStart(2, '0');
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  // Digits typed into the field fill its segments in the order the browser
  // shows them, day first or month first; read them the same way. The page's
  // language does not say: on macOS Chrome draws the fields in the system
  // region's order, and superapp flights-010 showed dd/mm/yyyy under an
  // en-US navigator.language, so "10112026" became 11 Oct.
  const dayFirst = typeof shownDayFirst === 'boolean'
    ? shownDayFirst
    : new Intl.DateTimeFormat(navigator.language)
        .formatToParts(new Date(2000, 10, 22))
        .find((p) => p.type === 'day' || p.type === 'month').type === 'day';
  // The step often names the date itself ("set the departure date to
  // 2026-11-10") while the planner types "11102026", guessing the field's
  // order wrong (superapp flights-009, round 6). When the digits read as two
  // dates and the step names one of them, that one is meant.
  const named = (d) => (hints || []).includes(d[0] + '-' + pad(d[1]) + '-' + pad(d[2]));
  const dmy = (a, b, y) => {
    if (a <= 12 && b <= 12 && named([y, a, b]) !== named([y, b, a])) {
      return named([y, a, b]) ? [y, a, b] : [y, b, a];
    }
    return a > 12 || (b <= 12 && dayFirst) ? [y, b, a] : [y, a, b];
  };
  let date = null;
  let m = v.match(/^(\\d{4})-(\\d{1,2})-(\\d{1,2})/);
  if (m) date = [+m[1], +m[2], +m[3]];
  if (!date && (m = v.match(/^(\\d{1,2})[\\/.-](\\d{1,2})[\\/.-](\\d{4})/))) {
    date = dmy(+m[1], +m[2], +m[3]);
  }
  // The planner types a date the way the field reads, without separators:
  // superapp flights-009 sent "11102026" and the year spilled into "102026".
  if (!date && (m = v.match(/^(\\d{2})(\\d{2})(\\d{4})$/))) {
    date = /^(19|20)\\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])$/.test(v)
      ? [+v.slice(0, 4), +v.slice(4, 6), +v.slice(6)]
      : dmy(+m[1], +m[2], +m[3]);
  }
  if (date && (date[1] < 1 || date[1] > 12 || date[2] < 1 || date[2] > 31)) date = null;
  if (!date && (m = v.match(/^([A-Za-z]{3})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})/))) {
    const mo = months.indexOf(m[1].toLowerCase());
    if (mo >= 0) date = [+m[3], mo + 1, +m[2]];
  }
  if (!date && (m = v.match(/^(\\d{1,2})(?:st|nd|rd|th)?\\s+([A-Za-z]{3})[a-z]*\\.?,?\\s+(\\d{4})/))) {
    const mo = months.indexOf(m[2].toLowerCase());
    if (mo >= 0) date = [+m[3], mo + 1, +m[1]];
  }
  let time = null;
  const t = v.match(/(?:^|[T\\s])(\\d{1,2}):(\\d{2})(?::\\d{2})?\\s*([ap]\\.?m\\.?)?/i);
  if (t) {
    let h = +t[1];
    const ap = (t[3] || '').toLowerCase();
    if (ap.startsWith('p') && h < 12) h += 12;
    if (ap.startsWith('a') && h === 12) h = 0;
    time = pad(h) + ':' + t[2];
  }
  let out = null;
  const ymd = date && date[0] + '-' + pad(date[1]) + '-' + pad(date[2]);
  if (type === 'date' && date) out = ymd;
  else if (type === 'month' && date) out = date[0] + '-' + pad(date[1]);
  else if (type === 'month' && (m = v.match(/^(\\d{4})-(\\d{1,2})$/))) out = m[1] + '-' + pad(+m[2]);
  else if (type === 'week' && (m = v.match(/^(\\d{4})-?W(\\d{1,2})$/i))) out = m[1] + '-W' + pad(+m[2]);
  else if (type === 'time' && time) out = time;
  else if (type === 'datetime-local' && date) out = ymd + 'T' + (time || '00:00');
  if (!out) return null;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  el.focus();
  setter.call(el, out);
  if (el.value !== out) return null;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return out;
})`;

async function setNativeTemporalInput(
  page: AbstractWebPage,
  element: ElementInfo,
  value: string,
): Promise<boolean> {
  if (!page.evaluateJavaScript || !element.center) {
    return false;
  }
  const [x, y] = element.center;
  const dayFirst = await page.dateFieldsDayFirst?.().catch(() => undefined);
  const set = await page
    .evaluateJavaScript<string | null>(
      `${NATIVE_TEMPORAL_INPUT}(${x}, ${y}, ${JSON.stringify(value)}, ${JSON.stringify(dayFirst ?? null)}, ${JSON.stringify(page.dateHints ?? [])})`,
    )
    .catch(() => null);
  if (typeof set !== 'string') {
    return false;
  }
  debugTypeText('set native temporal input to "%s" for "%s"', set, value);
  return true;
}

// A text field that takes a date names its format in the placeholder
// ("mm/dd/yyyy") and parses only that. The planner, guessing the field was
// segmented, typed superapp meridian-008's 12/24/2026 as "12242026"; the app
// refused the booking and reset the form. When the located field names a
// day/month/year format and the value is a date in another shape — digits
// alone, ISO, or "Dec 24, 2026" — type it in the field's format instead.
// A value already in that format, or a field with no format, is typed as is.
const TEXT_DATE_FORMAT = `((x, y, raw) => {
  let el = document.elementFromPoint(x, y);
  for (let i = 0; i < 5 && el && el.shadowRoot; i++) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (el && el.tagName === 'LABEL' && el.control) el = el.control;
  if (!el || el.tagName !== 'INPUT') return null;
  if (!['', 'text', 'search', 'tel'].includes((el.getAttribute('type') || '').toLowerCase())) return null;
  const SHAPE = /^(dd|mm|yyyy)([\\/.-])(dd|mm)\\2(dd|mm|yyyy)$/i;
  let fmt = null;
  for (const hint of [el.placeholder, el.dataset && el.dataset.datepicker, el.getAttribute('aria-label')]) {
    const h = String(hint || '').trim();
    if (SHAPE.test(h)) { fmt = h.toLowerCase(); break; }
  }
  if (!fmt) return null;
  const parts = fmt.match(SHAPE);
  const order = [parts[1], parts[3], parts[4]].map((p) => p.toLowerCase());
  if (order.slice().sort().join() !== 'dd,mm,yyyy') return null;
  const sep = parts[2];
  const v = String(raw).trim();
  const esc = sep.replace(/[.\\/-]/g, '\\\\$&');
  const shaped = new RegExp('^' + order.map((p) => (p === 'yyyy' ? '\\\\d{4}' : '\\\\d{1,2}')).join(esc) + '$');
  if (shaped.test(v)) return null;
  const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  let date = null;
  let m = v.match(/^(\\d{4})-(\\d{1,2})-(\\d{1,2})$/);
  if (m) date = { yyyy: +m[1], mm: +m[2], dd: +m[3] };
  if (!date && /^\\d{8}$/.test(v)) {
    if (order[0] !== 'yyyy' && /^(19|20)\\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])$/.test(v)) {
      date = { yyyy: +v.slice(0, 4), mm: +v.slice(4, 6), dd: +v.slice(6) };
    } else {
      date = {};
      let at = 0;
      for (const p of order) { const n = p === 'yyyy' ? 4 : 2; date[p] = +v.slice(at, at + n); at += n; }
    }
  }
  if (!date && (m = v.match(/^([A-Za-z]{3})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})$/))) {
    const mo = months.indexOf(m[1].toLowerCase());
    if (mo >= 0) date = { yyyy: +m[3], mm: mo + 1, dd: +m[2] };
  }
  if (!date && (m = v.match(/^(\\d{1,2})(?:st|nd|rd|th)?\\s+([A-Za-z]{3})[a-z]*\\.?,?\\s+(\\d{4})$/))) {
    const mo = months.indexOf(m[2].toLowerCase());
    if (mo >= 0) date = { yyyy: +m[3], mm: mo + 1, dd: +m[1] };
  }
  if (!date || date.mm < 1 || date.mm > 12 || date.dd < 1 || date.dd > 31) return null;
  return order.map((p) => (p === 'yyyy' ? String(date.yyyy) : String(date[p]).padStart(2, '0'))).join(sep);
})`;

async function textDateInFieldFormat(
  page: AbstractWebPage,
  element: ElementInfo,
  value: string,
): Promise<string> {
  if (!page.evaluateJavaScript || !element.center) {
    return value;
  }
  const [x, y] = element.center;
  const shaped = await page
    .evaluateJavaScript<string | null>(
      `${TEXT_DATE_FORMAT}(${x}, ${y}, ${JSON.stringify(value)})`,
    )
    .catch(() => null);
  if (typeof shaped !== 'string' || !shaped) {
    return value;
  }
  debugTypeText('typing "%s" as "%s", the date field\'s format', value, shaped);
  return shaped;
}

// superapp meridian-008: the date picker left open by the previous step
// covered the Comment textarea's center, so the click to focus it landed on
// the popup and the comment replaced the date. When something else sits on
// top of the field at the located point, click a part of the same field that
// is in the clear.
const UNCOVERED_FIELD_POINT = `((x, y) => {
  const editable = (e) => !!e && (e.isContentEditable || e.tagName === 'TEXTAREA' ||
    (e.tagName === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'].includes((e.type || '').toLowerCase())));
  const stack = document.elementsFromPoint(x, y);
  const top = stack[0];
  if (!top || editable(top) || top.closest('label')) return null;
  const field = stack.find(editable);
  if (!field || top.contains(field) || field.contains(top)) return null;
  const r = field.getBoundingClientRect();
  const xs = [0.85, 0.7, 0.95, 0.5, 0.3, 0.15, 0.05];
  const ys = [0.5, 0.25, 0.75, 0.1, 0.9];
  for (const fy of ys) {
    for (const fx of xs) {
      const px = Math.round(r.left + r.width * fx);
      const py = Math.round(r.top + r.height * fy);
      if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) continue;
      const hit = document.elementFromPoint(px, py);
      if (hit && (hit === field || field.contains(hit))) return [px, py];
    }
  }
  return null;
})`;

async function inTheClear(
  page: AbstractWebPage,
  element: ElementInfo,
): Promise<ElementInfo> {
  if (!page.evaluateJavaScript || !element.center) {
    return element;
  }
  const [x, y] = element.center;
  const point = await page
    .evaluateJavaScript<[number, number] | null>(
      `${UNCOVERED_FIELD_POINT}(${x}, ${y})`,
    )
    .catch(() => null);
  if (!Array.isArray(point)) {
    return element;
  }
  debugTypeText(
    'field at (%d, %d) is covered; typing through (%d, %d)',
    x,
    y,
    point[0],
    point[1],
  );
  return { ...element, center: point };
}

export function createWebInputPrimitives(
  page: AbstractWebPage,
): BrowserInputPrimitives {
  const scheduleVisualUpdate = () => scheduleWebVisualUpdate(page);

  return {
    pointer: {
      tap: async ({ x, y }) => {
        await page.mouse.click(x, y, { button: 'left' });
        scheduleVisualUpdate();
      },
      rightClick: async ({ x, y }) => {
        await page.mouse.click(x, y, { button: 'right' });
        scheduleVisualUpdate();
      },
      doubleClick: async ({ x, y }) => {
        await page.mouse.click(x, y, { button: 'left', count: 2 });
        scheduleVisualUpdate();
      },
      hover: async ({ x, y }) => {
        await page.mouse.move(x, y);
        scheduleVisualUpdate();
      },
      dragAndDrop: async (from, to) => {
        await page.mouse.drag(from, to);
        scheduleVisualUpdate();
      },
      longPress: async ({ x, y }, opts) => {
        await page.longPress(x, y, opts?.duration);
        scheduleVisualUpdate();
      },
    },
    keyboard: {
      typeText: async (rawValue, opts) => {
        const element = opts?.target
          ? await inTheClear(page, opts.target as ElementInfo)
          : undefined;
        let value = rawValue;
        if (
          element &&
          opts?.replace !== false &&
          !opts?.focusOnly &&
          (await setNativeTemporalInput(page, element as ElementInfo, value))
        ) {
          scheduleVisualUpdate();
          return;
        }
        if (element && opts?.replace !== false && !opts?.focusOnly) {
          value = await textDateInFieldFormat(
            page,
            element as ElementInfo,
            value,
          );
        }
        const { inputStrategy, keyboardTypeDelay } = resolveTextInputOptions(
          opts,
          page,
        );
        if (element && opts?.replace !== false) {
          if (inputStrategy === 'bulk') {
            // Keep the current value selected so insertText replaces it in one
            // input operation instead of emitting a separate empty value.
            await page.selectAllInput(element as ElementInfo);
          } else {
            await page.clearInput(element as ElementInfo);
            // Frameworks (React/Vue/etc.) often re-render in response to
            // the `input` event fired by clearing. If that re-render lands
            // between clearInput returning and the first typed character,
            // the keypresses can be dropped. Wait for the DOM to settle
            // before starting to type.
            await page.waitForDomQuiet?.({ target: element as ElementInfo });
          }
        } else if (element && opts?.focusOnly) {
          const target = element as ElementInfo;
          await page.mouse.click(target.center[0], target.center[1], {
            button: 'left',
          });
          await page.keyboard.press([{ key: 'End' }]);
        }

        if (opts?.focusOnly) {
          return;
        }

        if (inputStrategy === 'bulk') {
          await page.keyboard.insertText(value);
        } else if (inputStrategy === 'sequential') {
          await sendTextSequentially(
            value,
            {
              // The shared loop owns the inter-character delay. Explicitly
              // disable the page default so action-level zero remains
              // effective and positive delays are not applied twice.
              sendCharacter: (character) =>
                page.keyboard.type(character, { delay: 0 }),
              wait: sleep,
            },
            { delayMs: keyboardTypeDelay },
          );
        } else {
          const keyboardTypeOptions =
            keyboardTypeDelay === undefined
              ? undefined
              : { delay: keyboardTypeDelay };
          await page.keyboard.type(value, keyboardTypeOptions);
        }
        scheduleVisualUpdate();
      },
      keyboardPress: async (keyName, opts) => {
        const element = opts?.target as
          | { center: [number, number] }
          | undefined;
        if (element) {
          await page.mouse.click(element.center[0], element.center[1], {
            button: 'left',
          });
        }

        const keys = getKeyCommands(keyName);
        await page.keyboard.press(keys as any);
        scheduleVisualUpdate();
      },
      cursorMove: async (direction, times = 1) => {
        const arrowKey = direction === 'left' ? 'ArrowLeft' : 'ArrowRight';
        for (let i = 0; i < times; i++) {
          await page.keyboard.press([{ key: arrowKey as any }]);
          await sleep(100);
        }
      },
      clearInput: async (target) => {
        await page.clearInput(target as ElementInfo | undefined);
      },
    },
    touch: {
      pinch: async ({ x, y }, opts) => {
        await page.pinch(
          x,
          y,
          opts.startDistance,
          opts.endDistance,
          opts.duration,
        );
      },
      swipe: async (from, to, opts) => {
        await page.swipe(from, to, opts?.duration);
      },
    },
    scroll: {
      scroll: async (param) => {
        const element = param.locate;
        const startingPoint = element
          ? {
              left: element.center[0],
              top: element.center[1],
            }
          : undefined;
        const scrollToEventName = param?.scrollType;
        if (scrollToEventName === 'scrollToTop') {
          await page.scrollUntilTop(startingPoint);
        } else if (scrollToEventName === 'scrollToBottom') {
          await page.scrollUntilBottom(startingPoint);
        } else if (scrollToEventName === 'scrollToRight') {
          await page.scrollUntilRight(startingPoint);
        } else if (scrollToEventName === 'scrollToLeft') {
          await page.scrollUntilLeft(startingPoint);
        } else if (scrollToEventName === 'singleAction' || !scrollToEventName) {
          if (param?.direction === 'down' || !param || !param.direction) {
            await page.scrollDown(param?.distance || undefined, startingPoint);
          } else if (param.direction === 'up') {
            await page.scrollUp(param.distance || undefined, startingPoint);
          } else if (param.direction === 'left') {
            await page.scrollLeft(param.distance || undefined, startingPoint);
          } else if (param.direction === 'right') {
            await page.scrollRight(param.distance || undefined, startingPoint);
          } else {
            throw new Error(`Unknown scroll direction: ${param.direction}`);
          }
          await sleep(500);
        } else {
          throw new Error(
            `Unknown scroll event type: ${scrollToEventName}, param: ${JSON.stringify(
              param,
            )}`,
          );
        }
        scheduleVisualUpdate();
      },
    },
  };
}

export const commonWebActionsForWebPage = <T extends AbstractWebPage>(
  page: T,
  includeTouchEvents = false,
): DeviceAction<any>[] => {
  const input = createWebInputPrimitives(page);
  return [
    ...defineActionsFromInputPrimitives(input, {
      size: () => page.size(),
      includeSwipe: includeTouchEvents,
    }),

    defineAction<typeof navigateParamSchema, { url: string }>({
      name: 'Navigate',
      description:
        'Navigate the browser to a specified URL. Opens the URL in the current tab.',
      paramSchema: navigateParamSchema,
      sample: {
        url: 'https://www.example.com',
      },
      call: async (param) => {
        if (!page.navigate) {
          throw new Error(
            'Navigate operation is not supported on this page type',
          );
        }
        await page.navigate(param.url);
        scheduleWebVisualUpdate(page, true);
      },
    }),

    defineAction({
      name: 'Reload',
      supportedBySystemOne: true,
      description: 'Reload the current page',
      call: async () => {
        if (!page.reload) {
          throw new Error(
            'Reload operation is not supported on this page type',
          );
        }
        await page.reload();
        scheduleWebVisualUpdate(page, true);
      },
    }),

    defineAction({
      name: 'GoBack',
      supportedBySystemOne: true,
      description: 'Navigate back in browser history',
      call: async () => {
        if (!page.goBack) {
          throw new Error(
            'GoBack operation is not supported on this page type',
          );
        }
        await page.goBack();
        scheduleWebVisualUpdate(page, true);
      },
    }),
    defineAction({
      name: 'GoForward',
      supportedBySystemOne: true,
      description: 'Navigate forward in browser history',
      call: async () => {
        if (!page.goForward) {
          throw new Error(
            'GoForward operation is not supported on this page type',
          );
        }
        await page.goForward();
        scheduleWebVisualUpdate(page, true);
      },
    }),
  ];
};
