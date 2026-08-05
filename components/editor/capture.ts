export type CaptureFormat = 'jpeg' | 'png';

export type CaptureSessionOptions = {
  /** The preview frame's size in CSS pixels. Never changes during a session. */
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
  readonly mimeType: string;
  grab(): Promise<Uint8Array | null>;
  close(): Promise<void>;
};

type Reply = { ok?: boolean; error?: string };
type GrabReply = Reply & { data?: string };

/**
 * The frame rect, snapped down to whole device pixels.
 *
 * A frame edge that lands on a fractional device pixel (390 CSS px × 2.77 =
 * 1080.5) is only half covered by the iframe, so that row or column comes back
 * as a blend of the page and the editor's frame backdrop behind it — a hairline
 * along one edge. Snapping costs a sub-pixel sliver of the frame; the
 * alternative is a visible seam.
 *
 * The epsilon matters: the scale factor is itself a ratio of these dimensions,
 * so an exact fit like 693 × (1920/693) can land a hair under 1920 in floating
 * point and lose a whole pixel to the floor.
 */
function deviceSnappedClip(
  frameWidth: number,
  frameHeight: number,
  deviceScaleFactor: number,
) {
  const snap = (cssSize: number) =>
    Math.floor(cssSize * deviceScaleFactor + 1e-6);
  return {
    x: 0,
    y: 0,
    width: snap(frameWidth) / deviceScaleFactor,
    height: snap(frameHeight) / deviceScaleFactor,
    devicePixelWidth: snap(frameWidth),
    devicePixelHeight: snap(frameHeight),
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Open a capture session over the editor's own tab.
 *
 * The frame is captured by emulating the tab's device metrics at the frame's
 * CSS size and a device scale factor high enough for the requested output,
 * then screenshotting the frame's rect. Two things follow from that, and both
 * matter for sharpness:
 *
 *  - The emulated viewport is exactly the frame, so the iframe (pinned
 *    fullscreen at the frame's size while exporting) fills it precisely and
 *    the clip lands on the iframe alone, with no editor UI in it.
 *  - The child frame inherits the emulated scale factor, so the camera's
 *    transform rasters at `deviceScaleFactor × cameraScale` inside the page —
 *    real pixels, not an upscale of a 1× render.
 *
 * The frame size in CSS pixels is identical to the editor preview, so the page
 * lays out exactly as the user framed it — the scale factor only adds density.
 */
export async function openCaptureSession(
  opts: CaptureSessionOptions,
): Promise<CaptureSession> {
  const {
    frameWidth,
    frameHeight,
    targetWidth,
    targetHeight,
    format = 'jpeg',
    quality = 100,
  } = opts;

  // Take the larger of the two ratios so neither axis is ever under-sampled.
  // Any surplus is cropped 1:1 downstream — cheaper than resampling, which
  // would soften every pixel of every frame.
  const deviceScaleFactor = Math.max(
    targetWidth / frameWidth,
    targetHeight / frameHeight,
  );
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  const snapped = deviceSnappedClip(
    frameWidth,
    frameHeight,
    deviceScaleFactor,
  );
  const clip = {
    x: snapped.x,
    y: snapped.y,
    width: snapped.width,
    height: snapped.height,
  };

  const begin = (await browser.runtime.sendMessage({
    type: 'dolly:capture:begin',
    width: frameWidth,
    height: frameHeight,
    deviceScaleFactor,
  })) as Reply;
  if (!begin?.ok) {
    throw new Error(begin?.error ?? 'could not attach the debugger');
  }

  const end = async () => {
    try {
      await browser.runtime.sendMessage({ type: 'dolly:capture:end' });
    } catch (err) {
      console.warn('[Dolly] capture session teardown failed:', err);
    }
  };

  const grab = async (): Promise<Uint8Array | null> => {
    const res = (await browser.runtime.sendMessage({
      type: 'dolly:capture:grab',
      clip,
      format,
      quality,
    })) as GrabReply;
    if (!res?.ok || !res.data) {
      if (res?.error) console.warn('[Dolly] capture:', res.error);
      return null;
    }
    return base64ToBytes(res.data);
  };

  // Emulation relayouts the editor page; give it a paint before measuring.
  await new Promise((resolve) => setTimeout(resolve, 150));

  // Measure a real frame rather than trusting frameSize × scaleFactor:
  // Chrome rounds the emulated surface, and the encoder must be told the
  // truth or every frame gets resampled to fit.
  let width = snapped.devicePixelWidth;
  let height = snapped.devicePixelHeight;
  try {
    const probe = await grab();
    if (!probe) throw new Error('the first screenshot came back empty');
    const bitmap = await createImageBitmap(
      new Blob([probe as unknown as BlobPart], { type: mimeType }),
    );
    width = bitmap.width;
    height = bitmap.height;
    bitmap.close();
  } catch (err) {
    await end();
    throw new Error(`capture probe failed: ${err}`);
  }

  return {
    width,
    height,
    deviceScaleFactor,
    mimeType,
    grab,
    close: end,
  };
}
