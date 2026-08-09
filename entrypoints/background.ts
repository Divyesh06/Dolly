import { OVERLAY_CHANNEL } from '@/lib/protocol';

/**
 * Launcher and janitor. The controller owns the session and drives CDP, the
 * camera and the capture; this only opens a session and tears one down if the
 * controller dies without cleaning up. Session facts live in `storage.session`
 * so they survive the worker being torn down.
 */

/** Provisional — the controller re-places itself on mount. */
const CONTROLLER_HEIGHT = 340;
const STORE_KEY = 'dolly:active-session';

type StoredSession = {
  controllerWindowId: number;
  targetTabId: number;
  targetWindowId: number;
  /** Where the tab came from, so it can be put back on teardown. */
  originWindowId: number;
  originIndex: number;
};

async function readSession(): Promise<StoredSession | null> {
  const bag = await browser.storage.session.get(STORE_KEY);
  return (bag[STORE_KEY] as StoredSession | undefined) ?? null;
}

// Not in the manifest, so pages the user isn't recording never run Dolly code.
// Safe to repeat: the script bails if a copy is already running.
async function injectOverlay(tabId: number): Promise<boolean> {
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ['/content-scripts/dolly-overlay.js'],
    });
    return true;
  } catch (err) {
    console.warn('[Dolly] could not inject the overlay:', err);
    return false;
  }
}

async function writeSession(session: StoredSession | null) {
  if (session) await browser.storage.session.set({ [STORE_KEY]: session });
  else await browser.storage.session.remove(STORE_KEY);
}

/** Undo everything a session changed about the target tab and window. */
async function endSession(session: StoredSession) {
  await writeSession(null);

  // Backstop for helper windows a controller exited without closing.
  try {
    const helperTabs = await browser.tabs.query({
      url: [
        browser.runtime.getURL('/script-editor.html') + '*',
        browser.runtime.getURL('/export-curtain.html') + '*',
      ],
    });
    await Promise.all(
      helperTabs.map((tab) =>
        tab.windowId == null
          ? Promise.resolve()
          : browser.windows.remove(tab.windowId).catch(() => {}),
      ),
    );
  } catch {
    /* nothing to sweep */
  }

  try {
    await browser.tabs.sendMessage(
      session.targetTabId,
      { channel: OVERLAY_CHANNEL, op: 'release' },
      { frameId: 0 },
    );
  } catch {
    /* tab already gone, or never had the overlay */
  }

  // Emulation and the attachment belong to the extension rather than the
  // context that created them, so they can be undone from here.
  try {
    await browser.debugger.sendCommand(
      { tabId: session.targetTabId },
      'Emulation.clearDeviceMetricsOverride',
      {},
    );
  } catch {
    /* not attached */
  }
  try {
    await browser.debugger.detach({ tabId: session.targetTabId });
  } catch {
    /* not attached */
  }

  // Send the tab home. Dolly's popup closes itself once it's empty.
  try {
    await browser.tabs.move(session.targetTabId, {
      windowId: session.originWindowId,
      index: session.originIndex,
    });
    await browser.windows.update(session.originWindowId, { focused: true });
  } catch {
    // The original window is gone. Give the page an ordinary window of its
    // own rather than leaving it in a popup.
    try {
      await browser.windows.create({
        tabId: session.targetTabId,
        type: 'normal',
        focused: true,
      });
    } catch {
      /* the tab is gone too; nothing to rehome */
    }
  }
}

export default defineBackground(() => {
  browser.action.onClicked.addListener(async (tab) => {
    if (!tab.id || !tab.url || tab.windowId == null) return;
    // Dolly can't record its own pages, and injection is refused on chrome://
    // and the Web Store.
    if (tab.url.startsWith(browser.runtime.getURL(''))) return;
    if (!/^https?:|^file:/.test(tab.url)) {
      console.warn('[Dolly] cannot record', tab.url);
      return;
    }

    // An existing session owns the workspace; focus it rather than stacking.
    const existing = await readSession();
    if (existing) {
      try {
        await browser.windows.update(existing.controllerWindowId, {
          focused: true,
        });
        return;
      } catch {
        await endSession(existing);
      }
    }

    // In before the windows exist, so the controller's hello finds it listening.
    if (!(await injectOverlay(tab.id))) return;

    const originWindowId = tab.windowId;
    const originIndex = tab.index;

    // Moved, not copied, into a chrome-less popup: dropping the omnibox and tab
    // strip gives the frame 80-110px back, and moving preserves the page's
    // state where reopening the URL would not.
    let pageWindow;
    try {
      pageWindow = await browser.windows.create({
        tabId: tab.id,
        type: 'popup',
        focused: false,
      });
    } catch (err) {
      console.warn('[Dolly] could not move the tab into a popup:', err);
      return;
    }
    if (pageWindow?.id == null) return;

    const url =
      browser.runtime.getURL('/controller.html') +
      `?tab=${tab.id}&win=${pageWindow.id}`;

    // Provisional — the controller re-arranges both windows on mount, where
    // `screen` is available to measure against.
    const controller = await browser.windows.create({
      url,
      type: 'popup',
      focused: true,
      height: CONTROLLER_HEIGHT,
    });
    if (controller?.id == null) return;

    await writeSession({
      controllerWindowId: controller.id,
      targetTabId: tab.id,
      targetWindowId: pageWindow.id,
      originWindowId,
      originIndex,
    });
  });

  browser.windows.onRemoved.addListener(async (windowId) => {
    const session = await readSession();
    if (session?.controllerWindowId === windowId) await endSession(session);
  });

  // A navigation replaces the document and the overlay with it. Re-injected at
  // 'loading' to be back before the controller redraws on 'complete'.
  browser.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
    if (changeInfo.status !== 'loading') return;
    const session = await readSession();
    if (session?.targetTabId !== tabId) return;
    await injectOverlay(tabId);
  });

  // Losing the target tab leaves the controller pointing at nothing.
  browser.tabs.onRemoved.addListener(async (tabId) => {
    const session = await readSession();
    if (session?.targetTabId !== tabId) return;
    await writeSession(null);
    try {
      await browser.windows.remove(session.controllerWindowId);
    } catch {
      /* already closed */
    }
  });

  // If the user dismisses the debugger banner, the session can't continue.
  browser.debugger.onDetach.addListener(async (source) => {
    const session = await readSession();
    if (session && source.tabId === session.targetTabId) {
      await endSession(session);
      try {
        await browser.windows.remove(session.controllerWindowId);
      } catch {
        /* already closed */
      }
    }
  });
});
