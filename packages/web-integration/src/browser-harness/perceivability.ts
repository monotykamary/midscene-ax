/**
 * Deterministic perceivability check, run in the page on one element through
 * `Runtime.callFunctionOn` (`this` is the element). Ported from flow-pilot's
 * page helpers (`src/page-helpers.ts`, `perceivable`), where it gates every
 * "is it shown" verdict, so the tree rung and the pilot judge visibility the
 * same way:
 * - rendered at all (display, visibility, opacity, zero size);
 * - zero font size and transparent text colour;
 * - screen-reader-only clipping (1px boxes, `clip: rect(0 0 0 0)`, inset clip-path);
 * - positioned off-screen (outside the scrollable document);
 * - opacity 0 and overflow clipping on any ancestor, along the composed tree;
 * - covered: hit tests at five points of the visible part of the box, where a
 *   transparent layer on top does not count as a cover.
 * Hit tests and containment follow the composed (flat) tree, so elements
 * inside open shadow roots and slotted content are judged correctly.
 * Not ported: the overlay-dismissal hint, which names flow-pilot tools.
 *
 * Returns the element's viewport rect in CSS pixels (the units of `size()`)
 * with the verdict, so one round trip answers both.
 */
export const PERCEIVABILITY_FUNCTION = String.raw`function () {
  const node = this;
  const el = node && node.nodeType === 1 ? node : node && node.parentElement;
  if (!el) return { rect: { left: 0, top: 0, width: 0, height: 0 }, ok: false, why: 'not an element' };
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  let shadowMemo;
  const shadowy = () => {
    if (shadowMemo === undefined) { shadowMemo = false; for (const e of document.querySelectorAll('*')) if (e.shadowRoot) { shadowMemo = true; break; } }
    return shadowMemo;
  };
  const up = (n) => n.assignedSlot || n.parentElement || (n.parentNode && n.parentNode.host) || null;
  const deepContains = (a, b) => { for (let n = b; n; n = up(n)) if (n === a) return true; return false; };
  const deepHit = (x, y) => {
    let e = document.elementFromPoint(x, y);
    while (e && e.shadowRoot) { const inner = e.shadowRoot.elementFromPoint(x, y); if (!inner || inner === e) break; e = inner; }
    return e;
  };
  const flatText = (n) => {
    if (n.nodeType === 3) return n.textContent;
    if (n.nodeType !== 1 && n.nodeType !== 11) return '';
    let block = false;
    if (n.nodeType === 1) {
      if (/^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(n.tagName)) return '';
      const cs = getComputedStyle(n);
      if (cs.display === 'none') return '';
      block = !cs.display.startsWith('inline') && cs.display !== 'contents';
      if (n.tagName === 'SLOT') { const a = n.assignedNodes({ flatten: true }); return [...(a.length ? a : n.childNodes)].map(flatText).join(''); }
    }
    const kids = n.nodeType === 1 && n.shadowRoot ? n.shadowRoot.childNodes : n.childNodes;
    const inner = [...kids].map(flatText).join('');
    return block ? ' ' + inner + ' ' : inner;
  };
  const textOf = (e) => (shadowy() ? norm(flatText(e)) : norm(e.innerText ?? e.textContent ?? ''));
  const ownText = (e) => textOf(e);
  const visible = (e) => {
    if (!e || !e.isConnected) return false;
    const style = getComputedStyle(e);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return false;
    const rects = e.getClientRects();
    if (!rects.length) return false;
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const tagOf = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  const perceivable = (e) => {
    if (!visible(e)) return { ok: false, why: 'not rendered (display, visibility, opacity or zero size)' };
    const cs = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    if (parseFloat(cs.fontSize) === 0 && ownText(e)) return { ok: false, why: 'zero font size' };
    if (/rgba\([^)]*,\s*0\)$/.test(cs.color) && ownText(e) && !e.querySelector('*')) return { ok: false, why: 'transparent text colour' };
    if ((r.width <= 1 && r.height <= 1) || cs.clip === 'rect(0px, 0px, 0px, 0px)' || /inset\(\s*(50|100)%/.test(cs.clipPath)) return { ok: false, why: 'visually hidden (screen-reader-only clipping)' };
    if (r.right <= 0 || r.bottom <= -scrollY || r.left >= Math.max(document.documentElement.scrollWidth, innerWidth)) return { ok: false, why: 'positioned off-screen' };
    for (let a = up(e); a && a !== document.documentElement; a = up(a)) {
      if (a.nodeType !== 1) continue;
      const as = getComputedStyle(a);
      if (Number(as.opacity) === 0) return { ok: false, why: 'opacity 0 on ancestor ' + tagOf(a) };
      if (/(hidden|clip)/.test(as.overflow + as.overflowX + as.overflowY)) {
        const ar = a.getBoundingClientRect();
        const w = Math.min(r.right, ar.right) - Math.max(r.left, ar.left), h = Math.min(r.bottom, ar.bottom) - Math.max(r.top, ar.top);
        if (w <= 0 || h <= 0) return { ok: false, why: 'clipped away by ' + tagOf(a) + ' (overflow ' + as.overflow + ')' };
      }
    }
    const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, innerWidth), y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, innerHeight);
    if (x1 - x0 < 1 || y1 - y0 < 1) return { ok: true, note: 'outside the viewport; reachable by scrolling' };
    // A layer on top covers only where it paints: a transparent full-width strip (a nav list, a click-catcher)
    // lets the element show through, so it is not a cover.
    const paints = (hit, px, py) => {
      for (let n = hit; n && !deepContains(n, e); n = up(n)) {
        const ns = getComputedStyle(n);
        if (/^(IMG|SVG|CANVAS|VIDEO|IFRAME|INPUT|TEXTAREA|SELECT)$/i.test(n.tagName)) return true;
        if (ns.backgroundImage !== 'none') return true;
        const bg = ns.backgroundColor.match(/rgba?\(([^)]+)\)/);
        if (bg) { const parts = bg[1].split(',').map(Number); if ((parts.length < 4 || parts[3] > 0.05) && ns.backgroundColor !== 'transparent') return true; }
        for (const t of n.childNodes) {
          if (t.nodeType !== 3 || !t.textContent.trim()) continue;
          const range = document.createRange(); range.selectNodeContents(t);
          for (const tr of range.getClientRects()) if (px >= tr.left && px <= tr.right && py >= tr.top && py <= tr.bottom) return true;
        }
      }
      return false;
    };
    let top = null;
    for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
      const px = x0 + (x1 - x0) * fx, py = y0 + (y1 - y0) * fy;
      const hit = deepHit(px, py);
      if (!hit || hit === e || deepContains(e, hit) || deepContains(hit, e) || !paints(hit, px, py)) return { ok: true };
      top = hit;
    }
    return { ok: false, why: 'covered by ' + tagOf(top) + (ownText(top) ? ' "' + ownText(top).slice(0, 60) + '"' : '') };
  };
  const verdict = perceivable(el);
  const box = el.getBoundingClientRect();
  return { rect: { left: box.left, top: box.top, width: box.width, height: box.height }, ok: verdict.ok, why: verdict.why };
}`;

/** The shape `PERCEIVABILITY_FUNCTION` returns. */
export interface PerceivabilityProbe {
  rect: { left: number; top: number; width: number; height: number };
  ok: boolean;
  why?: string;
}

/**
 * Viewport offset of a frame's content box inside its parent frame, run on
 * the iframe element. Child-frame rects are frame-relative; adding the chain
 * of offsets puts them in the top-level viewport's CSS pixels.
 */
export const FRAME_OFFSET_FUNCTION = String.raw`function () {
  const r = this.getBoundingClientRect();
  return { left: r.left + this.clientLeft, top: r.top + this.clientTop };
}`;

/**
 * Counts DOM mutations in the main frame from an isolated world, so a cached
 * accessibility snapshot can be reused while the document is unchanged.
 * Installed once per document; returns the running count.
 */
export const MUTATION_COUNTER_EXPRESSION = String.raw`(() => {
  if (!window.__midsceneHarnessRevision) {
    const state = { count: 0 };
    new MutationObserver((records) => { state.count += records.length; })
      .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__midsceneHarnessRevision = state;
  }
  return window.__midsceneHarnessRevision.count;
})()`;
