import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { downloadBlob } from './download';

export type RenderOptions = {
  durationSeconds: number;
  /** Output size in device pixels. Must be even. */
  width: number;
  height: number;
  fps: number;
  /** MIME type of the bytes `captureFrame` returns. */
  frameMimeType: string;
  /** Advance the camera to `time` and wait for the frame to settle. */
  applyFrame: (time: number) => Promise<void>;
  /** Return the bytes of the current frame. */
  captureFrame: () => Promise<Uint8Array | null>;
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

/** Bits per pixel per second. Generous — zoomed text is what we're protecting. */
const BITS_PER_PIXEL = 0.2;
const MIN_BITRATE = 8_000_000;

let warnedUndersizedFrame = false;

/**
 * Bring a captured bitmap to the encoder's exact dimensions without ever
 * resampling it. The caller derives the output size from a measured capture,
 * so this is either a no-op or a centred 1:1 crop of a pixel or two. Scaling
 * here would soften every pixel of every frame, defeating the point of
 * rastering at export density in the first place.
 *
 * There is deliberately no background fill: the crop always covers the canvas,
 * and an undersized capture is an anomaly worth a warning rather than a
 * plausible-looking white edge.
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
    frameMimeType,
    applyFrame,
    captureFrame,
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

  try {
    for (let n = 0; n < totalFrames; n++) {
      if (isAborted()) break;
      await applyFrame(n / fps);
      if (isAborted()) break;

      // Backpressure: don't outrun the encoder.
      while (encoder.encodeQueueSize > 6 && !isAborted()) {
        await new Promise((r) => setTimeout(r, 5));
      }
      if (isAborted()) break;

      const bytes = await captureFrame();
      if (!bytes) continue;

      try {
        const bitmap = await createImageBitmap(
          new Blob([bytes as unknown as BlobPart], { type: frameMimeType }),
        );
        const frame = new VideoFrame(cropToSize(bitmap, width, height), {
          timestamp: Math.round((n * 1_000_000) / fps),
        });
        encoder.encode(frame, { keyFrame: n % (fps * 2) === 0 });
        frame.close();
        bitmap.close();
        capturedFrames++;
      } catch (err) {
        console.warn('[Dolly] encode failed at frame', n, err);
      }
    }
    aborted = isAborted();
  } finally {
    const captureMs = performance.now() - startTime;
    let fileSize = 0;
    let filename: string | undefined;
    let finalizeError: string | null = null;

    try {
      if (!aborted && capturedFrames > 0) {
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
      ok: !aborted && !finalizeError && capturedFrames > 0,
      capturedFrames,
      totalFrames,
      captureMs,
      totalMs,
      size: fileSize || undefined,
      filename,
      error: finalizeError || undefined,
    };
  }
}
