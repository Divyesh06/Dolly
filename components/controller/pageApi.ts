import animateCss from 'animate.css/animate.min.css?raw';
import { withTimeout } from '@/lib/async';
import { DRAWN_CARET_ID } from './caret';

/**
 * `window.Dolly` — the helpers a script keyframe can call.
 *
 * Keyframes are synchronous, which leaves no way to write something that takes
 * time. These close that gap by scheduling rather than waiting: they set their
 * work on the page's timers and return at once, and during an export those
 * timers are the stepped ones, so the result plays out over video time.
 */

const INSTALL_TIMEOUT_MS = 3000;

/* ────────────────────────────────────────────────────────────────────────────
 * Injected into the page. Serialised and re-parsed there, so it closes over
 * nothing — everything it needs is declared inside it.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Returns true if this call is what installed it, false if it was there. */
function installDollyApi(caretId: string): boolean {
  const win = window as unknown as Record<string, unknown>;

  /*
   * Always replaced, never skipped. A recorded tab is moved between windows
   * but never reloaded, so `window.Dolly` outlives a take — bailing out when
   * one is already there would leave the page running whichever version of
   * this API its first take injected, for the rest of the document's life.
   *
   * The stylesheet is what must not be repeated, so it gets its own marker.
   */
  const cssMarker = `${caretId}-css`;
  const needsStylesheet = !win[cssMarker];
  win[cssMarker] = true;

  type Target = string | Element | null | undefined;

  const find = (target: Target, method: string): HTMLElement | null => {
    const el =
      typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) {
      console.warn(`[Dolly] ${method}: nothing matched`, target);
      return null;
    }
    return el as HTMLElement;
  };

  const isField = (
    el: Element,
  ): el is HTMLInputElement | HTMLTextAreaElement =>
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

  const readText = (el: HTMLElement): string =>
    isField(el) ? el.value : (el.textContent ?? '');

  /**
   * Put `text` in the element as though it had been typed. Frameworks that own
   * an input's value — React above all — track it through the prototype's
   * setter and never see a plain `el.value = x`.
   */
  const write = (el: HTMLElement, text: string, last: boolean) => {
    if (isField(el)) {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      // `change` belongs at the end of the phrase, not after every letter.
      if (last) el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    el.textContent = text;
    if (el.isContentEditable) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };

  /**
   * Document coordinates, walked through the offset chain rather than read
   * from `getBoundingClientRect`. The camera is a transform on the page root,
   * and a rect would carry that transform — offsets are layout-only, so the
   * caret stays put however the shot moves.
   *
   * These are the *body's* coordinates, which page zoom scales. Anything
   * positioned from them has to sit inside the body to share that scale, or it
   * drifts further off the further along the text it goes.
   */
  const documentOffset = (el: HTMLElement) => {
    let x = 0;
    let y = 0;
    let node: HTMLElement | null = el;
    while (node) {
      x += node.offsetLeft;
      y += node.offsetTop;
      const parent = node.offsetParent as HTMLElement | null;
      if (parent) {
        x -= parent.scrollLeft;
        y -= parent.scrollTop;
      }
      node = parent;
    }
    return { x, y };
  };

  /** How wide `text` renders in `el`'s own font. */
  const textWidth = (el: HTMLElement, text: string): number => {
    let mirror = document.getElementById(`${caretId}-mirror`);
    if (!mirror) {
      mirror = document.createElement('span');
      mirror.id = `${caretId}-mirror`;
      mirror.setAttribute('aria-hidden', 'true');
      mirror.style.cssText =
        'position:absolute;left:-9999px;top:0;visibility:hidden;' +
        'white-space:pre;pointer-events:none;';
      document.body.appendChild(mirror);
    }
    const cs = getComputedStyle(el);
    // Copied one by one: the `font` shorthand is not reliably readable from a
    // computed style.
    mirror.style.fontFamily = cs.fontFamily;
    mirror.style.fontSize = cs.fontSize;
    mirror.style.fontWeight = cs.fontWeight;
    mirror.style.fontStyle = cs.fontStyle;
    mirror.style.letterSpacing = cs.letterSpacing;
    mirror.style.textTransform = cs.textTransform;
    mirror.textContent = text;
    return mirror.offsetWidth;
  };

  /**
   * Dolly's own caret, in place of the native one.
   *
   * A native caret blinks on a browser timer that runs on real time, so across
   * a capture — where a second of video costs many seconds — it strobes. This
   * one is a plain element: it does not blink, and it takes the field's own
   * caret colour, so it reads as that page's caret rather than Dolly's.
   *
   * Single-line fields only. A textarea wraps, and finding the caret's line
   * would mean re-implementing the line breaker.
   */
  const drawCaret = (el: HTMLElement, text: string) => {
    if (!(el instanceof HTMLInputElement)) return;

    const cs = getComputedStyle(el);
    const padLeft = parseFloat(cs.paddingLeft) || 0;
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const borderTop = parseFloat(cs.borderTopWidth) || 0;
    const padRight = parseFloat(cs.paddingRight) || 0;
    const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
    const content = Math.max(0, el.clientWidth - padLeft - padRight);
    const measured = textWidth(el, text);

    let offset: number;
    if (cs.textAlign === 'right' || cs.textAlign === 'end') {
      offset = padLeft + content;
    } else if (cs.textAlign === 'center') {
      offset = padLeft + content / 2 + measured / 2;
    } else {
      offset = padLeft + measured;
    }
    // Never past the content box, and never behind it once the text scrolls.
    offset = Math.max(padLeft, Math.min(offset, padLeft + content));
    offset -= el.scrollLeft;

    let caret = document.getElementById(caretId);
    if (!caret) {
      caret = document.createElement('div');
      caret.id = caretId;
      caret.setAttribute('aria-hidden', 'true');
      document.body.appendChild(caret);
    }

    /*
     * The field's own caret colour, read before it is hidden and then kept on
     * the element: a second call would otherwise read back the transparent set
     * here. `auto` and `transparent` fall through to the text colour, which is
     * what `auto` resolves to anyway. Doubles as the marker teardown looks for.
     */
    let colour = el.getAttribute('data-dolly-caret');
    if (colour === null) {
      const declared = cs.caretColor;
      colour =
        declared && declared !== 'auto' && declared !== 'transparent'
          ? declared
          : cs.color;
      el.setAttribute('data-dolly-caret', colour);
      el.style.setProperty('caret-color', 'transparent');
    }

    /*
     * Sized in the field's own font, so it follows whatever the type is set at:
     * 1.25em tall — a little over the text, as a caret should be — and a hair
     * over a pixel wide. The margin is the gap back to the text.
     *
     * Centred on the *content* box rather than the border box, so uneven
     * padding cannot push it off, and by translation, so nothing here has to
     * resolve the em height into pixels.
     */
    const { x, y } = documentOffset(el);
    const middle = y + borderTop + padTop + (el.clientHeight - padTop - padBottom) / 2;
    caret.style.cssText =
      'position:absolute;z-index:2147483646;pointer-events:none;' +
      `background:${colour};font-size:${cs.fontSize};` +
      'height:1.25em;width:max(1px, 0.07em);margin-left:0.14em;' +
      'transform:translateY(-50%);' +
      `left:${Math.round(x + borderLeft + offset)}px;` +
      `top:${Math.round(middle)}px;`;
  };

  const Dolly = {
    /**
     * Type `text` into an element over `ms`, a character at a time.
     *
     * Dolly.type('#search', 'wireless headphones', 1200)
     *
     * Options: `clear` empties the element first (default: types onto the end
     * of what is already there), `focus` false leaves focus alone.
     */
    type(
      target: Target,
      text: string,
      ms: number,
      options?: { clear?: boolean; focus?: boolean },
    ): void {
      const el = find(target, 'type()');
      if (!el) return;

      const value = String(text ?? '');
      const total = Math.max(0, Number(ms) || 0);
      const opts = options ?? {};

      if (opts.focus !== false) {
        // Never let focus scroll the page; the camera decides the framing.
        try {
          el.focus({ preventScroll: true });
        } catch {
          /* not focusable */
        }
      }

      const base = opts.clear ? '' : readText(el);
      if (opts.clear) write(el, '', false);
      // Drawn only where the caret belongs: a field nothing is typing into,
      // or one left unfocused, should not sprout one.
      const caret = opts.focus !== false;
      if (caret) drawCaret(el, base);
      if (!value) return;

      // No duration asked for: put it all in at this instant.
      if (total === 0) {
        write(el, base + value, true);
        if (caret) drawCaret(el, base + value);
        return;
      }

      const perCharacter = total / value.length;
      for (let i = 1; i <= value.length; i++) {
        const shown = base + value.slice(0, i);
        const last = i === value.length;
        // The page's own timer, read live: during an export that is the
        // stepped clock.
        setTimeout(() => {
          write(el, shown, last);
          if (caret) drawCaret(el, shown);
        }, Math.round(perCharacter * i));
      }
    },

    /**
     * Play an animate.css effect on an element over `ms`.
     *
     * Dolly.animate('.price-tag', 'bounceIn', 700)
     *
     * Every effect at https://animate.style works, named as it is there, with
     * or without the `animate__` prefix. Options: `delay` in ms, `repeat` as a
     * count or 'infinite', and `hold` to keep the effect's final state —
     * defaulting to true for exit effects, which would otherwise snap back
     * into view.
     */
    animate(
      target: Target,
      effect: string,
      ms: number,
      options?: { delay?: number; repeat?: number | 'infinite'; hold?: boolean },
    ): void {
      const el = find(target, 'animate()');
      if (!el) return;

      const name = String(effect ?? '').trim();
      if (!name) {
        console.warn('[Dolly] animate(): no effect named');
        return;
      }
      const className = name.startsWith('animate__') ? name : `animate__${name}`;
      const total = Math.max(0, Number(ms) || 0);
      const opts = options ?? {};
      const delay = Math.max(0, Number(opts.delay) || 0);

      // Clear, then force a reflow: re-adding a class the element already
      // carries does not restart a CSS animation.
      el.classList.remove('animate__animated', className);
      void el.offsetWidth;

      if (total > 0) el.style.setProperty('--animate-duration', `${total}ms`);
      if (delay > 0) el.style.setProperty('animation-delay', `${delay}ms`);
      if (opts.repeat != null) {
        el.style.setProperty('animation-iteration-count', String(opts.repeat));
      }
      el.classList.add('animate__animated', className);

      const exits = /out|hinge/i.test(name);
      const hold = opts.hold ?? exits;
      // Held by leaving the class on: animate.css fills forwards.
      if (hold || opts.repeat === 'infinite') return;

      setTimeout(() => {
        el.classList.remove('animate__animated', className);
        el.style.removeProperty('--animate-duration');
        el.style.removeProperty('animation-delay');
        el.style.removeProperty('animation-iteration-count');
      }, total + delay);
    },
  };

  win.Dolly = Dolly;
  return needsStylesheet;
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Make `window.Dolly` available to script keyframes in the recorded page.
 * Cheap to call repeatedly: the API is replaced each time, so a rebuilt
 * extension takes effect without reloading the page, while the stylesheet
 * follows only a document that has not had it yet.
 */
export async function installPageApi(targetTabId: number): Promise<boolean> {
  try {
    const results = await withTimeout(
      browser.scripting.executeScript({
        target: { tabId: targetTabId },
        world: 'MAIN',
        func: installDollyApi,
        args: [DRAWN_CARET_ID],
      } as Parameters<typeof browser.scripting.executeScript>[0]),
      INSTALL_TIMEOUT_MS,
      'installing the page API',
    );
    if (!results) return false;

    // The API is re-installed every time; only the stylesheet is once-only.
    const needsStylesheet = results.some((r) => r?.result === true);
    if (needsStylesheet) {
      await withTimeout(
        browser.scripting.insertCSS({
          target: { tabId: targetTabId },
          css: animateCss,
        }),
        INSTALL_TIMEOUT_MS,
        'inserting the effect stylesheet',
      );
    }
    return true;
  } catch (err) {
    console.warn('[Dolly] could not install the page API:', err);
    return false;
  }
}
