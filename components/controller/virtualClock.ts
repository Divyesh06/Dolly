import { withTimeout } from '@/lib/async';

/**
 * A clock for the recorded page, installed in its own JS world.
 *
 * The capture loop runs far from real time — a frame costs as long as posing,
 * rastering and screenshotting take — so anything the page animates on its own
 * clock would come out fast-forwarded. `performance.now`, `Date`, the timers
 * and `requestAnimationFrame` are swapped for ones this module drives, and
 * every running animation is paused and seeked by hand.
 *
 * The renderer keeps running on real time throughout, so it still commits,
 * rasters and answers screenshots. Dolly's overlay lives in the isolated
 * content-script world, whose globals this never touches, so its settle
 * handshake keeps working.
 */

const CLOCK_KEY = '__dollyVirtualClock';
/** Timer callbacks one step may run before the rest are held over. */
const MAX_TASKS_PER_STEP = 2000;
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
 * nothing — a reference to anything in this module throws on injection.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Swap the page's clocks for ones `stepPageClock` drives. */
function installPageClock(key: string, maxTasks: number): boolean {
  /** Times the page may be handed control within one step, to let it quiesce. */
  const MAX_SETTLE_ROUNDS = 8;

  const win = window as unknown as Record<string, unknown>;
  // An export that died before releasing leaves its clock behind, already
  // advanced and holding the page's animations wherever it abandoned them.
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

  // Captured before anything is patched: this module's own machinery has to
  // run on real time. Bound, so a page that has hardened its globals can't
  // trip an illegal invocation on them.
  const realPerfNow = performance.now.bind(performance);
  const RealDate = Date;
  const realSetTimeout = window.setTimeout.bind(window);
  const realClearTimeout = window.clearTimeout.bind(window);
  const realSetInterval = window.setInterval.bind(window);
  const realClearInterval = window.clearInterval.bind(window);
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancelRaf = window.cancelAnimationFrame.bind(window);
  const realAttachShadow = Element.prototype.attachShadow;
  const realIdle = win.requestIdleCallback;
  const realCancelIdle = win.cancelIdleCallback;

  const perfOrigin = realPerfNow();
  const wallOrigin = RealDate.now();

  /** Milliseconds the page's clock has advanced since it was frozen. */
  let virtual = 0;
  let released = false;

  const timers = new Map<number, Timer>();
  let rafs = new Map<number, (t: number) => void>();
  /** Far above any real handle, so the two sets of ids can't collide. */
  let nextHandle = 1e9;

  /** Where each animation stood when first seen, so it can be seeked. */
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

  // Shadow trees keep their own animation list. Walked once for what exists,
  // then patched for what comes later — which also catches closed roots.
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
   * CSS and WAAPI animations run against the document timeline, which no JS
   * clock reaches, so they have to be paused and positioned explicitly. New
   * ones are picked up here, which is how a transition started mid-shot gets
   * its start time.
   */
  const syncAnimations = () => {
    // An animation missing from the last sync began after it, so it can only
    // have run for the virtual time since. Its own `currentTime` reports the
    // real time it accrued while the export was busy elsewhere, which for one
    // frame of shot can be seconds.
    const sinceLastSync = virtual - lastSync;
    for (const anim of allAnimations()) {
      try {
        let baseline = baselines.get(anim);
        if (!baseline) {
          const elapsed = asMs(anim.currentTime);
          baseline = {
            at: virtual,
            // What was already running at install keeps its progress.
            time: firstSync ? elapsed : Math.min(elapsed, sinceLastSync),
          };
          baselines.set(anim, baseline);
          anim.pause();
        }
        const rate =
          typeof anim.playbackRate === 'number' ? anim.playbackRate : 1;
        anim.currentTime = baseline.time + (virtual - baseline.at) * rate;
      } catch {
        /* scroll-driven and other unseekable animations refuse this */
      }
    }
    lastSync = virtual;
    firstSync = false;
  };

  performance.now = () => perfOrigin + virtual;

  // Typed as a bag so the statics can be hung off it; `Date`'s own declaration
  // marks them read-only.
  const FakeDate = function (this: unknown, ...args: unknown[]) {
    // Only the argument-less form reads the clock.
    if (args.length === 0) {
      return new (RealDate as unknown as new (ms: number) => Date)(
        wallOrigin + virtual,
      );
    }
    return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
  } as unknown as Record<string, unknown>;
  FakeDate.now = () => wallOrigin + virtual;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  // Keeps `x instanceof Date` true for what this hands back.
  FakeDate.prototype = RealDate.prototype;
  win.Date = FakeDate;

  win.setTimeout = (fn: unknown, ms?: unknown, ...args: unknown[]) => {
    // A string body is `eval` in disguise; let the real timer have it.
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
    // Clamped as the real ones are, so one timer can't spin a step for ever.
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

  // A page that defers work to idle time would never do it otherwise.
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
   * Hand control back on a real task, so the microtask checkpoint runs.
   * Promise continuations only run once this stack unwinds.
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
    // Drained repeatedly because firing a timer only queues what was awaiting
    // it, and that continuation commonly schedules the next timer in a chain.
    let fired = 0;
    for (let round = 0; round < MAX_SETTLE_ROUNDS; round++) {
      fired = drainTimers(target, fired);
      await yieldToPage();
      if (released) return;
      if (fired >= maxTasks || !nextDue(target)) break;
    }
    virtual = target;

    // One animation frame per exported frame. The queue is taken first, so a
    // callback that re-registers itself is served by the next step rather
    // than spinning inside this one.
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

    // Once more, so the frame callbacks' continuations and DOM writes land
    // before the animations are read below.
    await yieldToPage();
    if (released) return;

    // Last, so anything created above is caught in this frame.
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

    // Hand back what was held, so queued work isn't left half-run.
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
 * Run one of the functions above in the page's own world, in every frame:
 * iframes animate too, and each has its own clock. Any frame answering counts
 * as success, since results come back in no guaranteed order and a frame that
 * refuses injection shouldn't take the shot down with it.
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
 * Returns null if the page won't take the clock, leaving it on real time.
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
      // A failed step means the clock is gone, a navigation most likely.
      // Reported once rather than per remaining frame.
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
