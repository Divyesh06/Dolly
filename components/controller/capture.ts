import { delay, withTimeout } from '@/lib/async';

export type CaptureFormat = 'jpeg' | 'png';

/** Probes allowed while waiting for the emulated surface to reach its new size. */
const PROBE_ATTEMPTS = 5;
const PROBE_INTERVAL_MS = 80;
/** Chrome rounds the emulated surface, so a pixel or two off is expected. */
const PROBE_TOLERANCE_PX = 2;
/** Relayout needs a beat before the first frame is meaningful. */
const RELAYOUT_SETTLE_MS = 150;
/**
 * A screenshot needs the compositor to hand over a frame, which a wedged page
 * may never do. Dropping one frame beats blocking the export on it.
 */
const CAPTURE_TIMEOUT_MS = 2000;


export type CaptureSessionOptions = {
  targetTabId: number;
  /** The frame's size in CSS pixels. Never changes during a session. */
  frameWidth: number;
  frameHeight: number;
  /** Smallest acceptable output size in device pixels. */
  targetWidth: number;
  targetHeight: number;
  format?: CaptureFormat;
  /** JPEG quality, 0–100. Ignored for PNG. */
  quality?: number;
};

export type CaptureSession = {
  /** Exact device-pixel size of every frame this session yields. */
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor: number;
  /** A decoded frame, carrying its own MIME type. */
  grab(): Promise<Blob | null>;
};

/**
 * Attach the debugger and pin the tab's viewport to the frame's CSS size at the
 * device scale the requested output needs, so the camera's transform rasters at
 * `deviceScaleFactor × cameraScale` real pixels. No teardown of its own: the
 * emulation stays so the page keeps laying out at the frame size, and
 * `releaseTab` is what clears it.
 */
export async function openCaptureSession(
  opts: CaptureSessionOptions,
): Promise<CaptureSession> {
  const {
    targetTabId,
    frameWidth,
    frameHeight,
    targetWidth,
    targetHeight,
    format = 'jpeg',
    quality = 100,
  } = opts;

  // Larger of the two ratios, so neither axis is under-sampled. Surplus is
  // cropped 1:1 by the encoder; resampling would soften every pixel.
  const deviceScaleFactor = Math.max(
    targetWidth / frameWidth,
    targetHeight / frameHeight,
  );
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';

  await setDeviceMetrics(targetTabId, {
    width: frameWidth,
    height: frameHeight,
    deviceScaleFactor,
  });

  const grab = async (): Promise<Blob | null> => {
    // Unclipped: a clip crops nothing here but makes Chrome override device
    // metrics per call, seen as the page flashing between two scales mid-export.
    // `captureBeyondViewport` is stated rather than defaulted, since the default
    // has changed across versions and this is the whole point.
    const params: Record<string, unknown> = {
      format,
      captureBeyondViewport: false,
    };
    if (format === 'jpeg') params.quality = quality;
    try {
      const shot = (await withTimeout(
        browser.debugger.sendCommand(
          { tabId: targetTabId },
          'Page.captureScreenshot',
          params,
        ),
        CAPTURE_TIMEOUT_MS,
        'Page.captureScreenshot',
      )) as { data?: string } | null;
      if (!shot?.data) return null;
      // Decoded by `fetch` on a `data:` URL: the base64 is multi-megabyte at 4K,
      // so an `atob` char loop is real per-frame cost.
      const decoded = await fetch(`data:${mimeType};base64,${shot.data}`);
      return await decoded.blob();
    } catch (err) {
      console.warn('[Dolly] capture failed:', err);
      return null;
    }
  };

  await delay(RELAYOUT_SETTLE_MS);

  /**
   * Measure a real frame: Chrome rounds the emulated surface, and the encoder
   * must be told the truth or every frame gets resampled to fit.
   *
   * Probed repeatedly because the override takes a moment to land, and a frame
   * grabbed before it does comes back at the old scale — which would size the
   * encoder wrongly and crop or letterbox every frame that follows.
   */
  const expectedWidth = Math.round(frameWidth * deviceScaleFactor);
  const expectedHeight = Math.round(frameHeight * deviceScaleFactor);
  const onTarget = (size: { width: number; height: number }) =>
    Math.abs(size.width - expectedWidth) <= PROBE_TOLERANCE_PX &&
    Math.abs(size.height - expectedHeight) <= PROBE_TOLERANCE_PX;

  let measured: { width: number; height: number } | null = null;
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    if (attempt > 0) await delay(PROBE_INTERVAL_MS);
    const probe = await grab();
    if (!probe) continue;
    const bitmap = await createImageBitmap(probe);
    measured = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    if (onTarget(measured)) break;
  }

  if (!measured) {
    throw new Error('every probe screenshot came back empty');
  }
  // A surface that never reached the requested size is still the best
  // information available, so the export goes ahead on what was measured.
  if (!onTarget(measured)) {
    console.warn(
      `[Dolly] capture surface settled at ${measured.width}×${measured.height} ` +
        `rather than the ${expectedWidth}×${expectedHeight} requested; ` +
        'the output may be cropped or have blank edges',
    );
  }

  return {
    width: measured.width,
    height: measured.height,
    deviceScaleFactor,
    grab,
  };
}

/** Attach if needed, then pin the tab's viewport. Safe to call repeatedly. */
export async function setDeviceMetrics(
  targetTabId: number,
  metrics: { width: number; height: number; deviceScaleFactor: number },
) {
  await attach(targetTabId);
  await browser.debugger.sendCommand(
    { tabId: targetTabId },
    'Emulation.setDeviceMetricsOverride',
    { ...metrics, mobile: false },
  );
}

export async function attach(targetTabId: number) {
  try {
    await browser.debugger.attach({ tabId: targetTabId }, '1.3');
  } catch (err) {
    const message = String(err);
    // "Another debugger is already attached" means someone else holds the tab,
    // almost always DevTools. Checked first, since this message also contains
    // the "already attached" our own re-attach produces.
    if (message.includes('Another debugger')) {
      throw new Error(
        'DevTools (or another debugger) is open on the recorded tab, and ' +
          'Chrome allows only one debugger per tab. Close DevTools for that ' +
          'tab and try again.',
      );
    }
    // Already attached by us: normal on every call after the first.
    if (!message.includes('already attached')) {
      throw err;
    }
  }
  // An unfocused tab throttles rendering and drops focus styling; an occluded
  // one can stop producing frames entirely. Both would show up in the capture.
  try {
    await browser.debugger.sendCommand(
      { tabId: targetTabId },
      'Emulation.setFocusEmulationEnabled',
      { enabled: true },
    );
    await browser.debugger.sendCommand(
      { tabId: targetTabId },
      'Page.setWebLifecycleState',
      { state: 'active' },
    );
  } catch (err) {
    console.warn('[Dolly] render-state overrides failed:', err);
  }
}

/**
 * Answer the page's modal dialogs instead of letting them open.
 *
 * `alert`, `confirm` and friends block the renderer outright — no frames, no
 * screenshots, nothing — and left native they open *behind* the curtain, where
 * they can't be dismissed. Enabling the Page domain hands them to the debugger
 * instead, and the page stays blocked until one is answered, so the handler
 * below is what keeps the export moving.
 *
 * Returns the function that stops intercepting.
 */
export async function answerDialogs(
  targetTabId: number,
): Promise<() => Promise<void>> {
  const onEvent = (
    source: { tabId?: number },
    method: string,
    params?: unknown,
  ) => {
    if (source.tabId !== targetTabId) return;
    if (method !== 'Page.javascriptDialogOpening') return;
    const dialog = (params ?? {}) as { type?: string; message?: string };
    // `beforeunload` is answered "stay" — accepting it would navigate away from
    // the page being recorded. Everything else is dismissed so the shot goes on.
    const accept = dialog.type !== 'beforeunload';
    console.warn(
      `[Dolly] the page opened a ${dialog.type ?? 'dialog'} mid-export; ` +
        `answered automatically (${accept ? 'accepted' : 'dismissed'}): ` +
        `${dialog.message ?? ''}`,
    );
    void browser.debugger
      .sendCommand({ tabId: targetTabId }, 'Page.handleJavaScriptDialog', {
        accept,
      })
      .catch(() => {});
  };

  browser.debugger.onEvent.addListener(onEvent);
  try {
    await browser.debugger.sendCommand({ tabId: targetTabId }, 'Page.enable');
  } catch (err) {
    browser.debugger.onEvent.removeListener(onEvent);
    console.warn('[Dolly] could not intercept page dialogs:', err);
    return async () => {};
  }

  return async () => {
    browser.debugger.onEvent.removeListener(onEvent);
    try {
      await browser.debugger.sendCommand(
        { tabId: targetTabId },
        'Page.disable',
      );
    } catch {
      /* detached */
    }
  };
}

export async function releaseTab(targetTabId: number) {
  // Bounded: a wedged renderer must not let teardown hang the caller.
  await withTimeout(
    browser.debugger
      .sendCommand(
        { tabId: targetTabId },
        'Emulation.clearDeviceMetricsOverride',
        {},
      )
      .catch(() => null),
    1500,
    'clear device metrics',
  );
  await withTimeout(
    browser.debugger.detach({ tabId: targetTabId }).catch(() => null),
    1500,
    'debugger detach',
  );
}
