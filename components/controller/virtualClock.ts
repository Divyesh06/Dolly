import { withTimeout } from '@/lib/async';

/**
 * A clock for the recorded page, installed in its own JS world.
 *
 * The capture loop runs far from real time — a frame costs as long as posing,
 * rastering and screenshotting take — so anything the page animates on its own
 * clock comes out fast-forwarded. Chrome's virtual time (`Emulation
 * .setVirtualTimePolicy`) is the obvious tool and the wrong one: it freezes the
 * renderer's whole scheduler, which in headful Chrome stops the rendering
 * lifecycle without giving us the `HeadlessExperimental.beginFrame` that
 * headless uses to manufacture frames instead. Nothing commits, screenshots
 * come back stale, and compositor-driven animations tick on real vsync anyway.
 *
 * So the clock is replaced from inside the page instead. `performance.now`,
 * `Date`, the timers and `requestAnimationFrame` are swapped for ones this
 * module drives, and every running animation is paused and seeked by hand. The
 * renderer keeps running on real time throughout: it still commits, still
 * rasters, still answers screenshots — and Dolly's own overlay, which lives in
 * the isolated content-script world with its own untouched globals, keeps its
 * `requestAnimationFrame` settle handshake.
 */

/** Where the page-side clock parks itself. */
const CLOCK_KEY = '__dollyVirtualClock';
/**
 * Timer callbacks one step may run before the rest are held over. A page that
 * re-posts a zero-delay timer from its own callback would otherwise spin here
 * for ever, since its next timer is always due at the instant it just reached.
 */
const MAX_TASKS_PER_STEP = 2000;
/** Nothing in the capture loop may block for ever, this included. */
const STEP_TIMEOUT_MS = 2000;
const INSTALL_TIMEOUT_MS = 3000;
const RELEASE_TIMEOUT_MS = 2000;

export type PageClock = {
  /** Advance the page's clock by `ms`, running whatever that makes due. */
  step(ms: number): Promise<void>;
  /** Restore the page's own clock and let it run again. */
  release(): Promise<void>;
};

/* ────────────────────────────────────────────────────────────────────────────
 * Injected into the page. Serialised and re-parsed there, so these close over
 * nothing: everything they need arrives through arguments or `window`.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Swap the page's clocks for ones `stepPageClock` drives. */
function installPageClock(key: string, maxTasks: number): boolean {
  // Everything this function needs must be declared inside it: it is
  // serialised and re-parsed in the page, where the module around it does not
  // exist. A reference to anything out there throws on injection.

  /**
   * Times the page may be handed back control within one step, to let a chain
   * of awaited timers settle. Bounded: a page that schedules a fresh timer
   * from every continuation would otherwise never quiesce.
   */
  const MAX_SETTLE_ROUNDS = 8;

  const win = window as unknown as Record<string, unknown>;
  // An export that died before releasing leaves its clock behind. Reusing it
  // would start this shot on a clock already advanced, with the page's
  // animations parked wherever that one abandoned them.
  const stale = win[key] as { release?: () => void } | undefined;
  if (stale) {
    try {
      stale.release?.();
    } catch {
      /* it was already half gone */
    }
    delete win[key];
  }

  type Timer = {
    due: number;
    /** Period in ms for an interval; null for a one-shot. */
    interval: number | null;
    fn: (...args: unknown[]) => unknown;
    args: unknown[];
  };

  // Captured before anything is patched: the clock's own machinery has to run
  // on real time, or stepping it would depend on it already being stepped.
  // Bound, so calling them detached from `window` can't trip an illegal
  // invocation on a page that has hardened its globals.
  const realPerfNow = performance.now.bind(performance);
  const RealDate = Date;
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  const realSetInterval = window.setInterval.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancelRaf = window.cancelAnimationFrame.bind(window);
  const realAttachShadow = Element.prototype.attachShadow;
  // Restored by name, so the page isn't left with the stand-ins below.
  const realIdle = win.requestIdleCallback;
  const realCancelIdle = win.cancelIdleCallback;

  const perfOrigin = realPerfNow();
  const wallOrigin = RealDate.now();

  /** Milliseconds the page's clock has advanced since it was frozen. */
  let virtual = 0;
  let released = false;

  const timers = new Map<number, Timer>();
  let rafs = new Map<number, (t: number) => void>();
  // Far above any real handle, so a stray clear of one of ours can't cancel a
  // real timer the page owns (and vice versa).
  let nextHandle = 1e9;

  /**
   * Where each animation was when first seen, so it can be seeked rather than
   * having its progress guessed. Weak: a paused animation whose element is gone
   * must not be kept alive by this.
   */
  const baselines = new WeakMap<Animation, { at: number; time: number }>();
  const shadowRoots = new Set<ShadowRoot>();
  /** Where the clock stood at the previous sync, to bound new animations. */
  let lastSync = 0;
  /** The sync at install, whose animations predate the clock entirely. */
  let firstSync = true;

  /** `currentTime` is a CSSNumberish: a plain number today, a unit value soon. */
  const asMs = (value: unknown): number => {
    if (typeof value === 'number') return value;
    const unit = (value as { value?: unknown } | null)?.value;
    return typeof unit === 'number' ? unit : 0;
  };

  // Shadow trees keep their own animation list, so they have to be found. Once
  // at install for what already exists, then by patch for what comes later —
  // which also catches closed roots, unreachable any other way.
  const findShadowRoots = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const nested = (el as Element).shadowRoot;
      if (nested && !shadowRoots.has(nested)) {
        shadowRoots.add(nested);
        findShadowRoots(nested);
      }
    }
  };
  try {
    findShadowRoots(document);
  } catch {
    /* a hostile document; the main tree is still worth having */
  }
  Element.prototype.attachShadow = function (init: ShadowRootInit) {
    const root = realAttachShadow.call(this, init);
    shadowRoots.add(root);
    return root;
  };

  const allAnimations = (): Animation[] => {
    const found: Animation[] = [];
    try {
      found.push(...document.getAnimations());
    } catch {
      /* unsupported */
    }
    for (const root of shadowRoots) {
      try {
        found.push(...root.getAnimations());
      } catch {
        /* detached root */
      }
    }
    return found;
  };

  /**
   * Hold every animation at the page's current instant.
   *
   * CSS animations and transitions run on the compositor against real vsync,
   * so a swapped-out `performance.now` means nothing to them — they have to be
   * paused and positioned explicitly. Newly created ones are picked up here
   * too, which is how a transition started mid-shot gets its start time.
   */
  const syncAnimations = () => {
    // An animation missing from the last sync began after it, so it can only
    // legitimately have run for the virtual time since. Left alone it would
    // report the *real* time it accrued while the export was busy posing and
    // screenshotting — seconds, for a frame's worth of shot — and would enter
    // the video already finished.
    const sinceLastSync = virtual - lastSync;
    for (const anim of allAnimations()) {
      try {
        let baseline = baselines.get(anim);
        if (!baseline) {
          const elapsed = asMs(anim.currentTime);
          baseline = {
            at: virtual,
            // Whatever was already running when the clock was installed keeps
            // its progress; there was no blind window before that.
            time: firstSync ? elapsed : Math.min(elapsed, sinceLastSync),
          };
          baselines.set(anim, baseline);
          anim.pause();
        }
        const rate =
          typeof anim.playbackRate === 'number' ? anim.playbackRate : 1;
        anim.currentTime = baseline.time + (virtual - baseline.at) * rate;
      } catch {
        // Scroll-driven and otherwise unseekable animations refuse this; they
        // don't follow a clock in the first place.
      }
    }
    lastSync = virtual;
    firstSync = false;
  };

  performance.now = () => perfOrigin + virtual;

  const FakeDate = function (this: unknown, ...args: unknown[]) {
    // Only the argument-less form reads the clock; every other form is a
    // parse of something the caller already holds.
    if (args.length === 0) {
      return new (RealDate as unknown as new (ms: number) => Date)(
        wallOrigin + virtual,
      );
    }
    return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
    // Typed loosely so the statics below can be hung off it; `Date`'s own
    // declaration marks them read-only.
  } as unknown as Record<string, unknown>;
  FakeDate.now = () => wallOrigin + virtual;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  // Keeps `x instanceof Date` true for what this hands back.
  FakeDate.prototype = RealDate.prototype;
  win.Date = FakeDate;

  win.setTimeout = (fn: unknown, ms?: unknown, ...args: unknown[]) => {
    // A string body is `eval` in disguise and vanishingly rare; let the real
    // timer have it rather than reimplement it.
    if (typeof fn !== 'function') {
      return (realSetTimeout as (...a: unknown[]) => number)(fn, ms);
    }
    const handle = nextHandle++;
    timers.set(handle, {
      due: virtual + Math.max(0, Number(ms) || 0),
      interval: null,
      fn: fn as Timer['fn'],
      args,
    });
    return handle;
  };
  win.clearTimeout = (handle: unknown) => {
    if (timers.delete(handle as number)) return;
    (realClearTimeout as (h: unknown) => void)(handle);
  };
  win.setInterval = (fn: unknown, ms?: unknown, ...args: unknown[]) => {
    if (typeof fn !== 'function') {
      return (realSetInterval as (...a: unknown[]) => number)(fn, ms);
    }
    // Zero-delay intervals are clamped, as the real ones are, so a step can't
    // be spun for ever by one timer.
    const period = Math.max(1, Number(ms) || 0);
    const handle = nextHandle++;
    timers.set(handle, {
      due: virtual + period,
      interval: period,
      fn: fn as Timer['fn'],
      args,
    });
    return handle;
  };
  win.clearInterval = (handle: unknown) => {
    if (timers.delete(handle as number)) return;
    (realClearInterval as (h: unknown) => void)(handle);
  };

  win.requestAnimationFrame = (cb: unknown) => {
    if (typeof cb !== 'function') return 0;
    const handle = nextHandle++;
    rafs.set(handle, cb as (t: number) => void);
    return handle;
  };
  win.cancelAnimationFrame = (handle: unknown) => {
    if (rafs.delete(handle as number)) return;
    (realCancelRaf as (h: unknown) => void)(handle);
  };

  // Idle work is animation-adjacent enough to matter — a page that defers its
  // work to idle time would otherwise never do it while the clock is ours.
  if (typeof realIdle === 'function') {
    win.requestIdleCallback = (cb: unknown) => {
      if (typeof cb !== 'function') return 0;
      return (win.setTimeout as typeof setTimeout)(
        () =>
          (cb as (deadline: IdleDeadline) => void)({
            didTimeout: false,
            timeRemaining: () => 1,
          } as IdleDeadline),
        1,
      );
    };
    win.cancelIdleCallback = win.clearTimeout;
  }

  /** The earliest timer due by `target`, in fire order. */
  const nextDue = (target: number): [number, Timer] | null => {
    let bestHandle = -1;
    let best: Timer | null = null;
    for (const [handle, timer] of timers) {
      if (timer.due > target) continue;
      if (!best || timer.due < best.due) {
        best = timer;
        bestHandle = handle;
      }
    }
    return best ? [bestHandle, best] : null;
  };

  /**
   * Hand control back to the page on a real task, so the microtask checkpoint
   * runs. Promise continuations — everything downstream of an `await` — only
   * run once this function's own stack unwinds, so draining timers without
   * this would leave their `await`s unresolved.
   */
  const yieldToPage = () =>
    new Promise<void>((resolve) => realSetTimeout(() => resolve(), 0));

  /** Fire every timer due by `target`, in due order. Returns how many ran. */
  const drainTimers = (target: number, alreadyFired: number): number => {
    let fired = alreadyFired;
    for (;;) {
      const due = nextDue(target);
      if (!due) break;
      if (fired >= maxTasks) {
        console.warn(
          `[Dolly] the page still had timers due after ${maxTasks} of them ` +
            'in one frame; the rest were held over to the next',
        );
        break;
      }
      const [handle, timer] = due;
      virtual = Math.max(virtual, timer.due);
      if (timer.interval != null) timer.due = virtual + timer.interval;
      else timers.delete(handle);
      fired++;
      try {
        timer.fn(...timer.args);
      } catch (err) {
        console.error('[Dolly] a page timer threw:', err);
      }
    }
    return fired;
  };

  const step = async (ms: number): Promise<void> => {
    if (released) return;
    const target = virtual + Math.max(0, ms);

    // Timers fire at their own due time rather than all at the end of the
    // frame, so a callback that reads the clock sees when it actually ran.
    //
    // Drained repeatedly, because firing a timer only *queues* whatever was
    // awaiting it. That continuation runs at the microtask checkpoint once
    // this stack unwinds, and page code that sequences its own animation —
    // `await sleep(200)` between steps is the common shape — schedules the
    // next timer from there. A single pass would push each link of such a
    // chain into a later frame, spreading across the shot what the page meant
    // to happen at one instant.
    let fired = 0;
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
      fired = drainTimers(target, fired);
      await yieldToPage();
      if (released) return;
      if (fired >= maxTasks || !nextDue(target)) break;
    }
    virtual = target;

    // One animation frame per exported frame. The queue is taken first, so a
    // callback that re-registers itself — which is every animation loop — is
    // served by the next step rather than spinning inside this one.
    const pending = rafs;
    rafs = new Map();
    const timestamp = perfOrigin + virtual;
    for (const cb of pending.values()) {
      try {
        cb(timestamp);
      } catch (err) {
        console.error('[Dolly] a page animation frame threw:', err);
      }
    }

    // Once more, so the frame callbacks' own continuations and DOM writes are
    // in before the animations are read below and the frame is grabbed.
    await yieldToPage();
    if (released) return;

    // Last, so anything the work above created is caught in this frame rather
    // than being discovered a frame late.
    syncAnimations();
  };

  const release = () => {
    if (released) return;
    released = true;

    performance.now = realPerfNow;
    win.Date = RealDate;
    win.setTimeout = realSetTimeout;
    win.clearTimeout = realClearTimeout;
    win.setInterval = realSetInterval;
    win.clearInterval = realClearInterval;
    win.requestAnimationFrame = realRaf;
    win.cancelAnimationFrame = realCancelRaf;
    if (typeof realIdle === 'function') {
      win.requestIdleCallback = realIdle;
      win.cancelIdleCallback = realCancelIdle;
    }
    Element.prototype.attachShadow = realAttachShadow;

    // Hand back what was held, so a page that had work queued isn't left
    // half-run for the rest of its life.
    for (const timer of timers.values()) {
      try {
        if (timer.interval != null) {
          realSetInterval(() => timer.fn(...timer.args), timer.interval);
        } else {
          realSetTimeout(
            () => timer.fn(...timer.args),
            Math.max(0, timer.due - virtual),
          );
        }
      } catch {
        /* nothing to be done for this one */
      }
    }
    timers.clear();
    const pending = rafs;
    rafs = new Map();
    for (const cb of pending.values()) {
      try {
        realRaf(cb);
      } catch {
        /* nothing to be done for this one */
      }
    }

    for (const anim of allAnimations()) {
      try {
        if (baselines.has(anim)) anim.play();
      } catch {
        /* wasn't ours to resume */
      }
    }

    delete win[key];
  };

  win[key] = { step, release };
  // Freeze what is already running, so the shot starts from a still page.
  syncAnimations();
  return true;
}

function stepPageClock(key: string, ms: number): Promise<boolean> {
  const clock = (window as unknown as Record<string, unknown>)[key] as
    | { step(ms: number): Promise<void> }
    | undefined;
  if (!clock) return Promise.resolve(false);
  return clock.step(ms).then(() => true);
}

function releasePageClock(key: string): boolean {
  const clock = (window as unknown as Record<string, unknown>)[key] as
    | { release(): void }
    | undefined;
  if (!clock) return false;
  clock.release();
  return true;
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Run one of the functions above in the page's own world, in every frame.
 *
 * Iframes animate too and each has its own clock, so all of them are stepped.
 * Per-frame failures are ignored: a frame that refuses injection shouldn't
 * take the shot down with it — hence "any frame answered", rather than
 * singling one out, since the results come back in no guaranteed order.
 */
async function runInPage(
  targetTabId: number,
  func: (...args: never[]) => unknown,
  args: unknown[],
  label: string,
  timeoutMs: number,
): Promise<boolean> {
  const outcome = await withTimeout(
    browser.scripting
      .executeScript({
        target: { tabId: targetTabId, allFrames: true },
        world: 'MAIN',
        func: func as (...a: unknown[]) => unknown,
        args,
      } as Parameters<typeof browser.scripting.executeScript>[0])
      .then((results) => (results ?? []).some((r) => r?.result === true))
      .catch((err) => {
        console.warn(`[Dolly] ${label} failed:`, err);
        return false;
      }),
    timeoutMs,
    label,
  );
  return outcome === true;
}

/**
 * Freeze the recorded page's clock so the export can step it frame by frame.
 *
 * Returns null if the page won't take the clock; the export then runs on real
 * time, which is the old fast-forwarded behaviour.
 */
export async function openPageClock(
  targetTabId: number,
): Promise<PageClock | null> {
  const installed = await runInPage(
    targetTabId,
    installPageClock as (...args: never[]) => unknown,
    [CLOCK_KEY, MAX_TASKS_PER_STEP],
    'installing the page clock',
    INSTALL_TIMEOUT_MS,
  );
  if (!installed) return null;

  let broken = false;
  return {
    step: async (ms: number) => {
      if (broken) return;
      const ok = await runInPage(
        targetTabId,
        stepPageClock as (...args: never[]) => unknown,
        [CLOCK_KEY, ms],
        'stepping the page clock',
        STEP_TIMEOUT_MS,
      );
      // A step that fails means the clock is gone — a navigation, most likely.
      // Reporting it once beats a warning per remaining frame.
      if (!ok) {
        broken = true;
        console.warn(
          '[Dolly] the page clock stopped answering; the rest of the shot ' +
            "runs on the page's own time",
        );
      }
    },
    release: async () => {
      await runInPage(
        targetTabId,
        releasePageClock as (...args: never[]) => unknown,
        [CLOCK_KEY],
        'releasing the page clock',
        RELEASE_TIMEOUT_MS,
      );
    },
  };
}
