import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { downloadBlob } from './download';

export type RenderOptions = {
  durationSeconds: number;
  /** Output size in device pixels. Must be even. */
  width: number;
  height: number;
  fps: number;
  /** Advance the camera to `time` and wait for the frame to settle. */
  applyFrame: (time: number) => Promise<void>;
  /** The current frame, encoded. The Blob carries its own MIME type. */
  captureFrame: () => Promise<Blob | null>;
  /** Called once per frame attempted, whether or not it was captured. */
  onProgress?: (done: number, total: number) => void;
  abortSignal?: AbortSignal;
};

export type RenderResult = {
  ok: boolean;
  capturedFrames: number;
  totalFrames: number;
  captureMs: number;
  totalMs: number;
  size?: number;
  filename?: string;
  error?: string;
};

/** Bits per pixel per second. Generous: zoomed text is what this protects. */
const BITS_PER_PIXEL = 0.2;
const MIN_BITRATE = 8_000_000;
/** How long to wait on a busy encoder before pressing on regardless. */
const BACKPRESSURE_TIMEOUT_MS = 10_000;
/**
 * Empty captures in a row that mean the page has stopped answering. Grinding
 * out hundreds more frames at a timeout apiece helps nobody; failing quickly
 * with a reason does.
 */
const MAX_CONSECUTIVE_MISSES = 5;

let warnedUndersizedFrame = false;

/**
 * Bring a captured bitmap to the encoder's exact dimensions by cropping, never
 * scaling — resampling would soften every pixel of every frame. No background
 * fill: an undersized capture is an anomaly worth a warning, not a white edge.
 */
function cropToSize(
  bitmap: ImageBitmap,
  width: number,
  height: number,
): CanvasImageSource {
  if (bitmap.width === width && bitmap.height === height) return bitmap;

  if (bitmap.width < width || bitmap.height < height) {
    if (!warnedUndersizedFrame) {
      warnedUndersizedFrame = true;
      console.warn(
        `[Dolly] capture came back ${bitmap.width}×${bitmap.height}, ` +
          `smaller than the ${width}×${height} output — edges will be blank`,
      );
    }
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return bitmap;
  ctx.imageSmoothingEnabled = false;

  const copyWidth = Math.min(bitmap.width, width);
  const copyHeight = Math.min(bitmap.height, height);
  // Centre the crop so a surplus pixel is shared between opposite edges.
  const sx = Math.max(0, Math.floor((bitmap.width - width) / 2));
  const sy = Math.max(0, Math.floor((bitmap.height - height) / 2));
  ctx.drawImage(
    bitmap,
    sx,
    sy,
    copyWidth,
    copyHeight,
    0,
    0,
    copyWidth,
    copyHeight,
  );
  return canvas;
}

export async function renderVideo(opts: RenderOptions): Promise<RenderResult> {
  const {
    durationSeconds,
    width,
    height,
    fps,
    applyFrame,
    captureFrame,
    onProgress,
    abortSignal,
  } = opts;

  const totalFrames = Math.max(1, Math.ceil(durationSeconds * fps));
  const bitrate = Math.max(
    MIN_BITRATE,
    Math.round(width * height * fps * BITS_PER_PIXEL),
  );
  const config: VideoEncoderConfig = {
    codec: 'avc1.640034',
    width,
    height,
    framerate: fps,
    bitrate,
    bitrateMode: 'variable',
    latencyMode: 'quality',
    hardwareAcceleration: 'no-preference',
  };

  const failure = (error: string): RenderResult => ({
    ok: false,
    error,
    capturedFrames: 0,
    totalFrames,
    captureMs: 0,
    totalMs: 0,
  });

  let muxer: Muxer<ArrayBufferTarget>;
  let encoder: VideoEncoder;
  try {
    const support = await VideoEncoder.isConfigSupported(config);
    if (!support.supported) {
      return failure(`codec not supported for ${width}x${height}@${fps}`);
    }
    muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width, height, frameRate: fps },
      fastStart: 'in-memory',
    });
    encoder = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta) muxer.addVideoChunk(chunk, meta);
      },
      error: (e) => console.error('[Dolly] encoder error:', e),
    });
    encoder.configure(config);
  } catch (err) {
    return failure(`encoder init failed: ${err}`);
  }

  const startTime = performance.now();
  let capturedFrames = 0;
  let aborted = false;
  const isAborted = () => aborted || Boolean(abortSignal?.aborted);

  // Decode and encode run behind the capture loop, which is mostly waiting on
  // the compositor and CDP. The chain keeps frames in the order the encoder
  // requires while frame N decodes as N+1 is posed.
  let handoff: Promise<void> = Promise.resolve();
  let queued = 0;

  const submit = (encoded: Blob, n: number) => {
    queued++;
    handoff = handoff.then(async () => {
      try {
        const bitmap = await createImageBitmap(encoded);
        const frame = new VideoFrame(cropToSize(bitmap, width, height), {
          timestamp: Math.round((n * 1_000_000) / fps),
        });
        encoder.encode(frame, { keyFrame: n % (fps * 2) === 0 });
        frame.close();
        bitmap.close();
        capturedFrames++;
      } catch (err) {
        console.warn('[Dolly] encode failed at frame', n, err);
      } finally {
        queued--;
      }
    });
  };

  let loopError: string | null = null;
  let consecutiveMisses = 0;
  try {
    for (let n = 0; n < totalFrames; n++) {
      if (isAborted()) break;
      onProgress?.(n, totalFrames);
      await applyFrame(n / fps);
      if (isAborted()) break;

      // Backpressure: don't outrun the encoder, and don't let undecoded frames
      // pile up — at 4K each one is megabytes still in memory. Bounded, so a
      // stalled encoder slows the export instead of wedging it.
      const backpressureStart = performance.now();
      while ((encoder.encodeQueueSize > 6 || queued > 3) && !isAborted()) {
        if (performance.now() - backpressureStart > BACKPRESSURE_TIMEOUT_MS) {
          console.warn(
            `[Dolly] encoder still busy after ${BACKPRESSURE_TIMEOUT_MS}ms ` +
              `at frame ${n} (queue ${encoder.encodeQueueSize}, ` +
              `${queued} awaiting decode); carrying on`,
          );
          break;
        }
        await new Promise((r) => setTimeout(r, 5));
      }
      if (isAborted()) break;

      const encoded = await captureFrame();
      if (!encoded) {
        if (++consecutiveMisses >= MAX_CONSECUTIVE_MISSES) {
          throw new Error(
            `the page stopped returning frames at ${n} of ${totalFrames}`,
          );
        }
        continue;
      }
      consecutiveMisses = 0;
      submit(encoded, n);
    }
    await handoff;
    aborted = isAborted();
  } catch (err) {
    // Caught explicitly: the `return` in the `finally` below would otherwise
    // swallow it and report success with silently missing frames.
    loopError = String(err);
  } finally {
    const captureMs = performance.now() - startTime;
    let fileSize = 0;
    let filename: string | undefined;
    let finalizeError: string | null = null;

    try {
      // A crashed loop gets no file: a partial video that looks finished is
      // worse than a clear failure.
      if (!aborted && !loopError && capturedFrames > 0) {
        await encoder.flush();
        muxer.finalize();
        const buffer = muxer.target.buffer as unknown as ArrayBuffer;
        fileSize = buffer.byteLength;
        filename = `dolly-${new Date()
          .toISOString()
          .replace(/[:.]/g, '-')
          .slice(0, 19)}.mp4`;
        await downloadBlob(new Blob([buffer], { type: 'video/mp4' }), filename);
      }
      encoder.close();
    } catch (err) {
      finalizeError = String(err);
    }

    const totalMs = performance.now() - startTime;
    return {
      ok: !aborted && !loopError && !finalizeError && capturedFrames > 0,
      capturedFrames,
      totalFrames,
      captureMs,
      totalMs,
      size: fileSize || undefined,
      filename,
      error: loopError || finalizeError || undefined,
    };
  }
}
