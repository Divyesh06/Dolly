import { useCallback, useEffect, useRef } from 'preact/hooks';
import { withTimeout } from '@/lib/async';
import {
  buildTimeline,
  cameraAt,
  toFramePoint,
  type Camera,
} from '@/lib/camera';
import { buildCursorTrack, cursorAt, type CursorPose } from '@/lib/cursor';
import type { CursorPoint, FocusRegion } from '@/lib/effects';
import {
  EXPORT_CHANNEL,
  isExportNotice,
  type ExportNotice,
  type ExportOutcome,
  type OverlayResponse,
} from '@/lib/protocol';
import {
  answerDialogs,
  openCaptureSession,
  releaseTab,
  type CaptureSession,
} from './capture';
import { removeDrawnCaret } from './caret';
import { openCursorInput, type CursorInput } from './cursorInput';
import { getBounds, type SessionTarget, type Size } from './layout';
import { renderVideo, type RenderResult } from './renderer';
import { openPageClock, type PageClock } from './virtualClock';

/**
 * How much of the page window's top edge the curtain leaves uncovered: a fully
 * covered window can be marked occluded, and an occluded tab stops producing
 * frames. At the top, so the strip falls on chrome rather than page content.
 */
const CURTAIN_TOP_GAP = 24;

/** `tabs.sendMessage` has no timeout of its own. */
const POSE_TIMEOUT_MS = 1000;
const CLEANUP_TIMEOUT_MS = 2000;
const STALL_LOG_MS = 5000;
const SLOW_FRAME_LOG_MS = 2000;

const evenFloor = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

type StallWatch = {
  /** Name the phase the loop has just entered. */
  mark(label: string): void;
  /** Called as each frame begins, so a stall can say which one. */
  frame(done: number): void;
  close(): void;
};

/**
 * Console diagnostics for a capture that goes wrong. Every phase of the loop is
 * bounded, so a wedged export degrades into something slow rather than hanging
 * — which from the progress bar looks like a big shot rendering normally. This
 * names the phase responsible.
 */
function watchForStalls(): StallWatch {
  const phase = {
    label: 'starting',
    frame: 0,
    since: performance.now(),
    warned: false,
  };
  let frameStartedAt = performance.now();

  // Once per stall, not once per tick, so the cause isn't buried.
  const timer = window.setInterval(() => {
    const pending = performance.now() - phase.since;
    if (pending > STALL_LOG_MS && !phase.warned) {
      phase.warned = true;
      console.warn(
        `[Dolly] frame ${phase.frame}: '${phase.label}' still pending after ` +
          `${(pending / 1000).toFixed(1)}s`,
      );
    }
  }, STALL_LOG_MS);

  return {
    mark(label) {
      phase.label = label;
      phase.since = performance.now();
      phase.warned = false;
    },
    frame(done) {
      const now = performance.now();
      // Degradation usually precedes a stall by a few frames.
      if (done > 0 && now - frameStartedAt > SLOW_FRAME_LOG_MS) {
        console.warn(
          `[Dolly] frame ${done - 1} took ` +
            `${((now - frameStartedAt) / 1000).toFixed(1)}s`,
        );
      }
      frameStartedAt = now;
      phase.frame = done;
    },
    close() {
      window.clearInterval(timer);
    },
  };
}

/** The stats block. The curtain's headline states the outcome, so this doesn't. */
function formatResult(
  result: RenderResult | null,
  dims: { width: number; height: number; scaleFactor: number } | null,
): string {
  if (!result) return 'The export never started.';
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

export type UseExportArgs = {
  status: 'connecting' | 'ready' | 'lost';
  isPlaying: boolean;
  isExporting: boolean;
  setIsExporting: (exporting: boolean) => void;
  regions: FocusRegion[];
  cursors: CursorPoint[];
  frame: Size;
  target: SessionTarget;
  setPose: (
    camera: Camera | null,
    cursor: CursorPose | null,
    settle: boolean,
  ) => Promise<OverlayResponse>;
  runScriptsBetween: (from: number, to: number) => Promise<void>;
  /** Forget which script keyframes have fired; called as a take starts. */
  resetTake: () => void;
};

/** Rendering the shot to a file, behind the curtain window. */
export function useExport({
  status,
  isPlaying,
  isExporting,
  setIsExporting,
  regions,
  cursors,
  frame,
  target,
  setPose,
  runScriptsBetween,
  resetTake,
}: UseExportArgs) {
  const abortRef = useRef<AbortController | null>(null);

  const curtainRef = useRef<number | null>(null);
  /** Set while we're the ones closing it, so it isn't read as a cancel. */
  const closingCurtainRef = useRef(false);

  const tellCurtain = useCallback((notice: ExportNotice) => {
    if (curtainRef.current == null) return;
    void browser.runtime.sendMessage(notice).catch(() => {});
  }, []);

  /** Cover the page for the export: its sides and bottom, `CURTAIN_TOP_GAP` down. */
  const openCurtain = useCallback(async () => {
    if (target.windowId == null) return;
    const page = await getBounds(target.windowId);
    if (!page) return;
    try {
      const win = await browser.windows.create({
        url: browser.runtime.getURL('/export-curtain.html'),
        type: 'popup',
        focused: true,
        left: page.left,
        top: page.top + CURTAIN_TOP_GAP,
        width: page.width,
        height: Math.max(200, page.height - CURTAIN_TOP_GAP),
      });
      curtainRef.current = win?.id ?? null;
    } catch (err) {
      console.warn('[Dolly] could not open the export curtain:', err);
    }
  }, [target]);

  const closeCurtain = useCallback(async () => {
    const id = curtainRef.current;
    curtainRef.current = null;
    if (id == null) return;
    closingCurtainRef.current = true;
    try {
      await browser.windows.remove(id);
    } catch {
      /* already gone */
    } finally {
      closingCurtainRef.current = false;
    }
  }, []);

  // The curtain's Stop button and closing its window both abort the export.
  useEffect(() => {
    const onMessage = (msg: unknown) => {
      if (!isExportNotice(msg)) return;
      if ((msg as ExportNotice).op === 'cancel') abortRef.current?.abort();
    };
    const onClosed = (windowId: number) => {
      if (windowId !== curtainRef.current) return;
      curtainRef.current = null;
      if (!closingCurtainRef.current) abortRef.current?.abort();
    };
    browser.runtime.onMessage.addListener(onMessage);
    browser.windows.onRemoved.addListener(onClosed);
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      browser.windows.onRemoved.removeListener(onClosed);
    };
  }, []);

  const stopExport = useCallback(() => abortRef.current?.abort(), []);

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
      if (isExporting || isPlaying || status !== 'ready') return;
      if (target.tabId == null) return;
      const tabId = target.tabId;
      const timeline = buildTimeline(regions, frame.width, frame.height);
      const cursorTrack = buildCursorTrack(cursors);
      const duration = Math.max(timeline.duration, cursorTrack.duration);
      if (duration <= 0) return;

      const controller = new AbortController();
      abortRef.current = controller;
      setIsExporting(true);
      await openCurtain();

      const stalls = watchForStalls();

      let session: CaptureSession | null = null;
      let stopAnsweringDialogs: (() => Promise<void>) | null = null;
      let pageClock: PageClock | null = null;
      let pointer: CursorInput | null = null;
      let result: RenderResult | null = null;
      let failure: string | null = null;
      let width = evenFloor(opts.width);
      let height = evenFloor(opts.height);
      try {
        session = await openCaptureSession({
          targetTabId: target.tabId,
          frameWidth: frame.width,
          frameHeight: frame.height,
          targetWidth: width,
          targetHeight: height,
        });
        // Encode at the size the capture comes back at, so the fit stays a
        // pure crop and never resamples.
        width = evenFloor(session.width);
        height = evenFloor(session.height);
        console.info(
          `[Dolly] capturing ${session.width}×${session.height} at ` +
            `${session.deviceScaleFactor.toFixed(4)}× → ${width}×${height}`,
        );

        // A modal blocks the page's main thread, taking the overlay with it.
        stopAnsweringDialogs = await answerDialogs(tabId);

        // So the page's animations advance with the timeline rather than with
        // however long each frame takes to capture.
        pageClock = await openPageClock(tabId);
        if (!pageClock) {
          console.warn(
            '[Dolly] the page would not take a virtual clock; its own ' +
              'animations will run fast in the export',
          );
        }

        // The drawn cursor moves the real pointer with it, so the page lights
        // up under it as it would for a hand. The capture session already
        // holds the debugger this needs.
        pointer = await openCursorInput(tabId, frame);

        let poseMisses = 0;
        resetTake();
        let lastTime = -1e-6;
        result = await renderVideo({
          durationSeconds: duration,
          width,
          height,
          fps: opts.fps,
          applyFrame: async (t) => {
            // Scripts first: their changes must be in place before the pose
            // settles and the frame is grabbed.
            stalls.mark('scripts');
            await runScriptsBetween(lastTime, t);
            // Then the page's clock, so what it animates has reached this
            // instant before the camera is posed over it.
            stalls.mark('page clock');
            await pageClock?.step((t - lastTime) * 1000);
            lastTime = t;
            const camera = cameraAt(timeline, t);
            const cursor = cursorAt(cursorTrack, t);

            /*
             * With a pointer to drive, the pose is applied and settled in two
             * parts. Hit testing reads the page as it stands, so the camera
             * transform has to be on before the pointer moves — otherwise the
             * move lands on whatever the previous frame had under it, which at
             * high zoom is a different element entirely. The settle has to come
             * after, or the hover styles it triggers miss this frame.
             */
            stalls.mark('pose');
            const res = await withTimeout(
              setPose(camera, cursor, !pointer),
              POSE_TIMEOUT_MS,
              'pose',
            );
            if (!res?.ok) poseMisses++;

            if (pointer) {
              stalls.mark('pointer');
              await pointer.moveTo(
                cursor ? toFramePoint(camera, cursor) : null,
              );
              stalls.mark('settle');
              const settled = await withTimeout(
                setPose(camera, cursor, true),
                POSE_TIMEOUT_MS,
                'settle',
              );
              if (!settled?.ok) poseMisses++;
            }
            stalls.mark('capture');
          },
          captureFrame: () => session!.grab(),
          onProgress: (done, total) => {
            stalls.frame(done);
            tellCurtain({
              channel: EXPORT_CHANNEL,
              op: 'progress',
              done,
              total,
            });
          },
          abortSignal: controller.signal,
        });
        if (poseMisses > 0) {
          console.warn(
            `[Dolly] ${poseMisses} frame(s) captured without a settle ack`,
          );
        }
      } catch (err) {
        failure = String(err);
      } finally {
        stalls.close();
        // The clock first: everything after this wants the page behaving
        // normally again.
        await pageClock?.release();
        await pointer?.release();
        // Bounded, because a page that stopped answering is exactly when an
        // export fails, and the failure still has to be reported.
        await withTimeout(
          stopAnsweringDialogs?.() ?? Promise.resolve(),
          CLEANUP_TIMEOUT_MS,
          'stop answering dialogs',
        );
        // Whatever `Dolly.type` drew, and the fields it hid a caret on.
        await removeDrawnCaret(tabId);
        await withTimeout(
          setPose(null, null, false),
          CLEANUP_TIMEOUT_MS,
          'clearing the pose',
        );
        // Detached immediately so the debugger banner doesn't outlive the
        // export; this is the only path that needs it.
        if (target.tabId != null) await releaseTab(target.tabId);
        abortRef.current = null;
        setIsExporting(false);
      }

      // Cancelling wins over any error it caused on the way out: calling a
      // deliberate stop a failure would be a lie.
      const outcome: ExportOutcome = controller.signal.aborted
        ? 'cancelled'
        : failure || !result?.ok
          ? 'failed'
          : 'done';
      const summary =
        failure ??
        formatResult(
          result,
          session
            ? { width, height, scaleFactor: session.deviceScaleFactor }
            : null,
        );
      if (curtainRef.current != null) {
        tellCurtain({
          channel: EXPORT_CHANNEL,
          op: 'finished',
          outcome,
          summary,
        });
      } else if (outcome !== 'cancelled') {
        // The curtain was closed mid-export; nowhere else to report a problem.
        alert(summary);
      }
    },
    [
      regions,
      cursors,
      isExporting,
      isPlaying,
      status,
      target,
      frame,
      setPose,
      runScriptsBetween,
      resetTake,
      setIsExporting,
      openCurtain,
      tellCurtain,
    ],
  );

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  return { startExport, stopExport, closeCurtain };
}
