import animateCss from 'animate.css/animate.min.css?raw';
import { withTimeout } from '@/lib/async';

/**
 * `window.Dolly` — the helpers a script keyframe can call.
 *
 * Keyframes are synchronous: they run at one instant of the shot and the
 * capture moves on. That leaves no way to write something that takes time,
 * which is most of what a demo wants to show. These helpers close that gap by
 * *scheduling* rather than waiting — they set their work on the page's timers
 * and return at once, and during an export those timers are the stepped ones,
 * so the typing and the animations play out over video time no matter how long
 * each frame took to capture.
 *
 * Installed into the page's own world, so a snippet can reach it, and paired
 * with animate.css for the effect library.
 */

const INSTALL_TIMEOUT_MS = 3000;

/* ────────────────────────────────────────────────────────────────────────────
 * Injected into the page. Serialised and re-parsed there, so it closes over
 * nothing: everything it needs is declared inside it.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Returns true if this call is what installed it, false if it was there. */
function installDollyApi(): boolean {
  const win = window as unknown as Record<string, unknown>;
  if (win.Dolly) return false;

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
   * Put `text` in the element as though it had been typed.
   *
   * Frameworks that own an input's value — React above all — track it through
   * the prototype's setter and never see a plain `el.value = x`. Going through
   * the setter, then dispatching `input`, is what makes the change real to
   * them rather than something the next render wipes out.
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
      // Validation and "save on blur" logic usually hangs off `change`, and it
      // belongs at the end of the phrase rather than after every letter.
      if (last) el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    el.textContent = text;
    if (el.isContentEditable) {
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
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
        // Never let focus scroll the page: the camera decides what is on
        // screen, and a scroll under it would move the shot.
        try {
          el.focus({ preventScroll: true });
        } catch {
          /* not focusable */
        }
      }

      const base = opts.clear ? '' : readText(el);
      if (opts.clear) write(el, '', false);
      if (!value) return;

      // No duration asked for: put it all in at this instant.
      if (total === 0) {
        write(el, base + value, true);
        return;
      }

      const perCharacter = total / value.length;
      for (let i = 1; i <= value.length; i++) {
        const shown = base + value.slice(0, i);
        const last = i === value.length;
        // The page's own timer, read live: during an export that is the
        // stepped clock, so these land on the frames they belong to.
        setTimeout(() => write(el, shown, last), Math.round(perCharacter * i));
      }
    },

    /**
     * Play an animate.css effect on an element over `ms`.
     *
     * Dolly.animate('.price-tag', 'bounceIn', 700)
     *
     * Every effect at https://animate.style works, named as it is there, with
     * or without the `animate__` prefix. Options: `delay` in ms, `repeat` as a
     * count or 'infinite', and `hold` to decide whether the element keeps the
     * effect's final state — by default it does for the exit effects (the
     * `…Out` family and `hinge`, which would otherwise snap back into view)
     * and reverts for the rest.
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

      // Clear first, then force a reflow: re-adding a class the element
      // already carries does not restart a CSS animation, so playing the same
      // effect twice would do nothing the second time.
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
      // Held by simply leaving the class on: animate.css fills forwards, so
      // the last frame of the effect is where the element stays.
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
  return true;
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Make `window.Dolly` available to script keyframes in the recorded page.
 *
 * Cheap to call repeatedly: the page reports whether it already had the API,
 * and the stylesheet only follows a fresh install — which is also what makes
 * this correct across a navigation, since the new document has neither.
 */
export async function installPageApi(targetTabId: number): Promise<boolean> {
  try {
    const results = await withTimeout(
      browser.scripting.executeScript({
        target: { tabId: targetTabId },
        world: 'MAIN',
        func: installDollyApi,
      } as Parameters<typeof browser.scripting.executeScript>[0]),
      INSTALL_TIMEOUT_MS,
      'installing the page API',
    );
    if (!results) return false;

    const fresh = results.some((r) => r?.result === true);
    if (fresh) {
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
