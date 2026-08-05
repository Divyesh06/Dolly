/**
 * Debugger-backed capture for the editor tab.
 *
 * Everything happens on the top-level tab target. Chrome doesn't allow
 * `Page.captureScreenshot` on out-of-process iframe targets, and per-target
 * device metrics aren't available on them either â€” but the tab's emulated
 * scale factor does propagate into child frames, which is all the iframe
 * needs to raster at export density.
 */

const attached = new Set<number>();

type Clip = { x: number; y: number; width: number; height: number };

export default defineBackground(() => {
  browser.action.onClicked.addListener(async (tab) => {
    if (!tab.id || !tab.url) return;
    // Don't try to re-open the editor if we're already on it
    if (tab.url.startsWith(browser.runtime.getURL(''))) return;

    const editorUrl =
      browser.runtime.getURL('/editor.html') +
      '?src=' +
      encodeURIComponent(tab.url);
    try {
      await browser.tabs.update(tab.id, { url: editorUrl });
    } catch (err) {
      console.warn('[Dolly] tabs.update failed:', err);
    }
  });

  const detach = async (tabId: number) => {
    if (!attached.has(tabId)) return;
    try {
      await browser.debugger.sendCommand(
        { tabId },
        'Emulation.clearDeviceMetricsOverride',
        {},
      );
    } catch (err) {
      console.warn('[Dolly] clearing device metrics failed:', err);
    }
    try {
      await browser.debugger.detach({ tabId });
    } catch (err) {
      console.warn('[Dolly] detach failed:', err);
    }
    attached.delete(tabId);
  };

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    const m = msg as { type?: string };

    const respond = (work: () => Promise<unknown>) => {
      work()
        .then(sendResponse)
        .catch((err) => {
          console.error('[Dolly] capture handler rejected:', err);
          sendResponse({ ok: false, error: String(err) });
        });
      return true;
    };

    if (m?.type === 'dolly:capture:begin') {
      return respond(async () => {
        const p = m as {
          width: number;
          height: number;
          deviceScaleFactor: number;
        };

        if (!attached.has(tabId)) {
          await browser.debugger.attach({ tabId }, '1.3');
          attached.add(tabId);
        }

        // A backgrounded or unfocused tab throttles rendering and drops focus
        // styling; both would show up in the export.
        try {
          await browser.debugger.sendCommand(
            { tabId },
            'Emulation.setFocusEmulationEnabled',
            { enabled: true },
          );
          await browser.debugger.sendCommand(
            { tabId },
            'Page.setWebLifecycleState',
            { state: 'active' },
          );
        } catch (err) {
          console.warn('[Dolly] render-state emulation failed:', err);
        }

        await browser.debugger.sendCommand(
          { tabId },
          'Emulation.setDeviceMetricsOverride',
          {
            width: p.width,
            height: p.height,
            deviceScaleFactor: p.deviceScaleFactor,
            mobile: false,
          },
        );
        return { ok: true };
      });
    }

    if (m?.type === 'dolly:capture:grab') {
      return respond(async () => {
        if (!attached.has(tabId)) return { ok: false, error: 'not attached' };
        const p = m as {
          clip?: Clip;
          format?: 'jpeg' | 'png';
          quality?: number;
        };
        const format = p.format ?? 'jpeg';
        const params: Record<string, unknown> = { format };
        if (format === 'jpeg') params.quality = p.quality ?? 100;
        // The tab is emulated at the export scale factor, so a scale-1 clip
        // already comes back at full output density. Asking the screenshot to
        // scale on top of that would resample it.
        if (p.clip) params.clip = { ...p.clip, scale: 1 };

        const result = (await browser.debugger.sendCommand(
          { tabId },
          'Page.captureScreenshot',
          params,
        )) as { data?: string };
        if (!result?.data) return { ok: false, error: 'empty screenshot' };
        return { ok: true, data: result.data };
      });
    }

    if (m?.type === 'dolly:capture:end') {
      return respond(async () => {
        await detach(tabId);
        return { ok: true };
      });
    }
  });

  browser.debugger.onDetach.addListener((source) => {
    if (source.tabId) attached.delete(source.tabId);
  });
});
