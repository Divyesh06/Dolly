import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { RefObject } from 'preact';
import {
  DEFAULT_REGION_DURATION,
  TRANSITION_GAP,
  type FocusRegion,
} from './types';
import { buildTimeline, cameraAt, nextPaint, totalDuration } from './camera';
import { createFrameCamera, type FrameCamera } from './frameCamera';
import { openCaptureSession, type CaptureSession } from './capture';
import { renderVideo, type RenderResult } from './renderer';

const NO_CAMERA_MESSAGE =
  "Dolly can't reach the previewed page to apply the camera, so a zoomed " +
  'export would come out blurry.\n\nThis happens on about:blank, ' +
  'chrome:// URLs, and other pages where extensions are not allowed to run. ' +
  'Load a normal http(s) page in the preview and try again.';

function makeDefaultRegion(
  existing: FocusRegion[],
  frameWidth: number,
  frameHeight: number,
): FocusRegion {
  const lastEnd = existing.length
    ? Math.max(...existing.map((r) => r.endTime))
    : 0;
  const startTime = existing.length ? lastEnd + TRANSITION_GAP : 0;

  const aspect = frameWidth / frameHeight;
  // Fit a rectangle at the frame's own aspect ratio, ~60% of frame width
  // but not exceeding 80% of frame height.
  let width = frameWidth * 0.6;
  let height = width / aspect;
  if (height > frameHeight * 0.8) {
    height = frameHeight * 0.8;
    width = height * aspect;
  }

  return {
    id: crypto.randomUUID(),
    startTime,
    endTime: startTime + DEFAULT_REGION_DURATION,
    x: (frameWidth - width) / 2,
    y: (frameHeight - height) / 2,
    width,
    height,
  };
}

function formatResult(
  aborted: boolean,
  result: RenderResult | null,
  dims: { width: number; height: number; scaleFactor: number } | null,
): string {
  if (!result) return 'Export failed to start';
  const perFrame =
    result.capturedFrames > 0 ? result.captureMs / result.capturedFrames : 0;
  const effectiveFps =
    result.captureMs > 0
      ? (result.capturedFrames / result.captureMs) * 1000
      : 0;
  const sizeMB =
    result.size && result.size > 0
      ? (result.size / (1024 * 1024)).toFixed(2)
      : '—';
  return (
    (aborted ? 'Export aborted\n' : 'Export finished\n') +
    (dims
      ? `Output: ${dims.width}×${dims.height} ` +
        `(captured at ${dims.scaleFactor.toFixed(2)}× density)\n`
      : '') +
    `Total time: ${(result.totalMs / 1000).toFixed(2)}s\n` +
    `Capture phase: ${(result.captureMs / 1000).toFixed(2)}s\n` +
    `Frames captured: ${result.capturedFrames} / ${result.totalFrames}\n` +
    `Avg per frame: ${perFrame.toFixed(1)}ms\n` +
    `Effective capture rate: ${effectiveFps.toFixed(1)} fps\n` +
    `File size: ${sizeMB} MB` +
    (result.error ? `\nError: ${result.error}` : '')
  );
}

const evenFloor = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

export type UseEditorArgs = {
  iframeRef: RefObject<HTMLIFrameElement>;
  frameWidth: number;
  frameHeight: number;
};

export function useEditor({
  iframeRef,
  frameWidth,
  frameHeight,
}: UseEditorArgs) {
  const [regions, setRegions] = useState<FocusRegion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [playheadTime, setPlayheadTime] = useState(0);
  const rafRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const cameraRef = useRef<FrameCamera | null>(null);

  // One camera channel into the preview iframe, shared by playback and
  // export, so what you see while playing is what gets captured.
  const frameCamera = useCallback((): FrameCamera => {
    if (!cameraRef.current) {
      cameraRef.current = createFrameCamera(() => iframeRef.current);
    }
    return cameraRef.current;
  }, [iframeRef]);

  const addRegion = useCallback(() => {
    setRegions((prev) => {
      const next = makeDefaultRegion(prev, frameWidth, frameHeight);
      setSelectedId(next.id);
      return [...prev, next];
    });
  }, [frameWidth, frameHeight]);

  // Refit existing regions when the frame's aspect ratio changes.
  useEffect(() => {
    const aspect = frameWidth / frameHeight;
    setRegions((prev) => {
      let changed = false;
      const next = prev.map((r) => {
        const currentAspect = r.width / r.height;
        if (Math.abs(currentAspect - aspect) < 0.001) return r;
        changed = true;
        const centerX = r.x + r.width / 2;
        const centerY = r.y + r.height / 2;
        let newWidth = r.width;
        let newHeight = newWidth / aspect;
        if (newHeight > frameHeight) {
          newHeight = frameHeight;
          newWidth = newHeight * aspect;
        }
        if (newWidth > frameWidth) {
          newWidth = frameWidth;
          newHeight = newWidth / aspect;
        }
        const newX = Math.max(
          0,
          Math.min(frameWidth - newWidth, centerX - newWidth / 2),
        );
        const newY = Math.max(
          0,
          Math.min(frameHeight - newHeight, centerY - newHeight / 2),
        );
        return { ...r, width: newWidth, height: newHeight, x: newX, y: newY };
      });
      return changed ? next : prev;
    });
  }, [frameWidth, frameHeight]);

  const updateRegion = useCallback(
    (id: string, patch: Partial<FocusRegion>) => {
      setRegions((prev) =>
        prev.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      );
    },
    [],
  );

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    cameraRef.current?.release();
    setIsPlaying(false);
  }, []);

  const play = useCallback(async () => {
    if (rafRef.current !== null || isExporting) return;
    const timeline = buildTimeline(regions, frameWidth, frameHeight);
    if (timeline.duration <= 0) return;

    const camera = frameCamera();
    if (!(await camera.connect())) {
      console.warn(
        '[Dolly] no camera in the preview frame; playback will not zoom',
      );
    }

    const startFrom = playheadTime >= timeline.duration ? 0 : playheadTime;
    setPlayheadTime(startFrom);
    setIsPlaying(true);

    const startWall = performance.now();
    const tick = () => {
      const t = startFrom + (performance.now() - startWall) / 1000;
      if (t >= timeline.duration) {
        setPlayheadTime(timeline.duration);
        rafRef.current = null;
        camera.release();
        setIsPlaying(false);
        return;
      }
      setPlayheadTime(t);
      camera.set(cameraAt(timeline, t));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [
    regions,
    playheadTime,
    isExporting,
    frameWidth,
    frameHeight,
    frameCamera,
  ]);

  const seek = useCallback(
    (t: number) => {
      if (isPlaying) return;
      setPlayheadTime(Math.max(0, Math.min(totalDuration(regions), t)));
    },
    [regions, isPlaying],
  );

  const stopExport = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!isExporting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopExport();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isExporting, stopExport]);

  const startExport = useCallback(
    async (opts: { width: number; height: number; fps: number }) => {
      if (isExporting || isPlaying) return;
      const timeline = buildTimeline(regions, frameWidth, frameHeight);
      if (timeline.duration <= 0) {
        alert('Add at least one focus region before exporting.');
        return;
      }

      // The camera has to be reachable before we commit to an export — there
      // is no sharp fallback, so refuse rather than ship a blurry file.
      const camera = frameCamera();
      if (!(await camera.connect())) {
        alert(NO_CAMERA_MESSAGE);
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;

      // Pin the frame fullscreen first: the capture emulates the tab's
      // viewport down to the frame's exact size, so the iframe has to already
      // be the thing filling it.
      setIsExporting(true);
      await nextPaint();

      let session: CaptureSession | null = null;
      let result: RenderResult | null = null;
      let width = evenFloor(opts.width);
      let height = evenFloor(opts.height);
      try {
        session = await openCaptureSession({
          frameWidth,
          frameHeight,
          targetWidth: width,
          targetHeight: height,
        });
        // Encode at the size the capture actually comes back at, rounded down
        // to even. That keeps the fit path a pure crop — the output is never
        // resampled, and an edge can never fall back to a fill colour.
        width = evenFloor(session.width);
        height = evenFloor(session.height);
        console.info(
          `[Dolly] capturing ${session.width}×${session.height} at ` +
            `${session.deviceScaleFactor.toFixed(4)}× → ${width}×${height}`,
        );

        let settleMisses = 0;
        result = await renderVideo({
          durationSeconds: timeline.duration,
          width,
          height,
          fps: opts.fps,
          frameMimeType: session.mimeType,
          applyFrame: async (t) => {
            if (!(await camera.setAndSettle(cameraAt(timeline, t)))) {
              settleMisses++;
            }
          },
          captureFrame: () => session!.grab(),
          abortSignal: controller.signal,
        });
        if (settleMisses > 0) {
          console.warn(
            `[Dolly] ${settleMisses} frame(s) were captured without a settle ack`,
          );
        }
      } catch (err) {
        alert(`Export failed: ${err}`);
      } finally {
        // Release the camera before tearing down emulation, or the transform
        // stays stuck on the previewed page's root element.
        camera.release();
        await session?.close();
        abortRef.current = null;
        setIsExporting(false);
      }

      if (result) {
        alert(
          formatResult(
            controller.signal.aborted,
            result,
            session
              ? {
                  width,
                  height,
                  scaleFactor: session.deviceScaleFactor,
                }
              : null,
          ),
        );
      }
    },
    [
      regions,
      isExporting,
      isPlaying,
      frameWidth,
      frameHeight,
      frameCamera,
    ],
  );

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      abortRef.current?.abort();
      cameraRef.current?.release();
      cameraRef.current?.dispose();
    };
  }, []);

  return {
    regions,
    selectedId,
    isPlaying,
    isExporting,
    playheadTime,
    setSelectedId,
    addRegion,
    updateRegion,
    play,
    stop,
    seek,
    startExport,
    stopExport,
  };
}
