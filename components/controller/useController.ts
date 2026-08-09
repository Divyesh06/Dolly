import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { withTimeout } from '@/lib/async';
import type { Camera } from '@/lib/camera';
import type { CursorPose } from '@/lib/cursor';
import { CURSOR_BASE_SIZE } from '@/lib/effects';
import {
  OVERLAY_CHANNEL,
  isEditNotice,
  isScriptRequest,
  type EditCommand,
  type EditNotice,
  type OverlayRequest,
  type OverlayResponse,
  type ScriptRequest,
  type ScriptResponse,
} from '@/lib/protocol';
import { commandForKey, isEditableTarget } from '@/lib/shortcuts';
import { byStart } from '@/lib/timeline';
import { releaseTab } from './capture';
import {
  initialFrame,
  readTarget,
  screenOrigin,
  type Measurement,
  type Size,
} from './layout';
import { installPageApi } from './pageApi';
import { executeInPage } from './pageScript';
import { useExport } from './useExport';
import { usePlayback } from './usePlayback';
import { useTracks } from './useTracks';
import { useWorkspace } from './useWorkspace';

export type UseControllerArgs = {
  aspectW: number;
  aspectH: number;
};

/** How long one script keyframe's injection may take before it is given up on. */
const SCRIPT_TIMEOUT_MS = 5000;

/**
 * Composes the controller window from `useTracks`, `useWorkspace`, `usePlayback`
 * and `useExport`, and owns the glue: page messaging and session lifecycle.
 */
export function useController({ aspectW, aspectH }: UseControllerArgs) {
  const [status, setStatus] = useState<'connecting' | 'ready' | 'lost'>(
    'connecting',
  );
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  /** The largest rectangle of the chosen aspect ratio the page window can be. */
  const [frame, setFrame] = useState<Size>(() => initialFrame(aspectW, aspectH));
  const target = useRef(readTarget()).current;

  const send = useCallback(
    async (req: OverlayRequest): Promise<OverlayResponse> => {
      if (target.tabId == null) return { ok: false, error: 'no target tab' };
      try {
        const res = await browser.tabs.sendMessage(target.tabId, req, {
          frameId: 0,
        });
        return (res as OverlayResponse) ?? { ok: false, error: 'no response' };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
    [target],
  );

  /** Push one instant of the shot: camera and cursor sampled together. */
  const setPose = useCallback(
    (
      camera: Camera | null,
      cursor: CursorPose | null,
      settle: boolean,
    ): Promise<OverlayResponse> =>
      send({
        channel: OVERLAY_CHANNEL,
        op: 'pose',
        camera: camera
          ? { s: camera.scale, tx: camera.translateX, ty: camera.translateY }
          : null,
        cursor,
        settle,
      }),
    [send],
  );

  const measureViewport = useCallback(async (): Promise<Measurement | null> => {
    const res = await send({ channel: OVERLAY_CHANNEL, op: 'measure' });
    if (!res.ok || res.innerWidth == null || res.innerHeight == null) {
      return null;
    }
    return {
      width: res.innerWidth,
      height: res.innerHeight,
      scrollX: res.scrollX ?? 0,
      scrollY: res.scrollY ?? 0,
      document: {
        width: res.documentWidth ?? res.innerWidth,
        height: res.documentHeight ?? res.innerHeight,
      },
    };
  }, [send]);

  const tracks = useTracks({ frame, measureViewport });

  // ── script keyframes during a take ───────────────────────────────────────

  /** Keyframes already run in the current take; reset when one starts. */
  const firedRef = useRef(new Set<string>());
  /** Whether this take has already put `window.Dolly` in the page. */
  const apiReadyRef = useRef(false);
  const resetTake = useCallback(() => {
    firedRef.current.clear();
    apiReadyRef.current = false;
  }, []);

  /** Run every script keyframe the playhead just crossed, in time order. */
  const runScriptsBetween = useCallback(
    async (from: number, to: number) => {
      if (target.tabId == null) return;
      const due = byStart(
        tracks.scriptsRef.current.filter(
          (s) =>
            s.startTime > from &&
            s.startTime <= to &&
            !firedRef.current.has(s.id),
        ),
      );
      // Lazily, so a shot with no scripts never pays for the stylesheet.
      if (due.length > 0 && !apiReadyRef.current) {
        apiReadyRef.current = true;
        await installPageApi(target.tabId);
      }

      for (const script of due) {
        firedRef.current.add(script.id);
        // Bounded: this runs inside the capture loop, where nothing may block
        // for ever.
        const outcome = await withTimeout(
          executeInPage(target.tabId, script.code),
          SCRIPT_TIMEOUT_MS,
          `script keyframe at ${script.startTime.toFixed(2)}s`,
        );
        if (outcome && !outcome.ok) {
          console.warn('[Dolly] script keyframe failed:', outcome.error);
        }
      }
    },
    [target, tracks.scriptsRef],
  );

  const playback = usePlayback({
    status,
    isPlaying,
    setIsPlaying,
    isExporting,
    regions: tracks.regions,
    cursors: tracks.cursors,
    frame,
    shotDuration: tracks.shotDuration,
    setPose,
    runScriptsBetween,
    resetTake,
  });

  const exporter = useExport({
    status,
    isPlaying,
    isExporting,
    setIsExporting,
    regions: tracks.regions,
    cursors: tracks.cursors,
    frame,
    target,
    setPose,
    runScriptsBetween,
    resetTake,
  });

  const workspace = useWorkspace({
    aspectW,
    aspectH,
    status,
    busy: isPlaying || isExporting,
    target,
    setFrame,
    measureViewport,
    remapTracks: tracks.remapTracks,
  });

  // ── session lifecycle ────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const hello = await send({ channel: OVERLAY_CHANNEL, op: 'hello' });
      if (cancelled) return;
      // The header's status chip carries the explanation; a modal over a window
      // the user hasn't seen yet would only be in the way.
      if (!hello.ok) {
        setStatus('lost');
        return;
      }
      await workspace.dockAtStart();
      if (!cancelled) setStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
    // Initial placement happens once; after that the user owns the windows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A navigation replaces the document, taking the overlay with it. The window
  // size survives, so only the overlay needs redrawing.
  useEffect(() => {
    if (target.tabId == null) return;
    const onUpdated = (tabId: number, change: { status?: string }) => {
      if (tabId !== target.tabId || change.status !== 'complete') return;
      if (isPlaying || isExporting) return;
      void send({
        channel: OVERLAY_CHANNEL,
        op: 'render',
        frameWidth: frame.width,
        frameHeight: frame.height,
        regions: tracks.regions,
        cursors: tracks.cursors,
        selectedId: tracks.selectedId,
      });
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    return () => browser.tabs.onUpdated.removeListener(onUpdated);
  }, [
    target,
    isPlaying,
    isExporting,
    tracks.regions,
    tracks.cursors,
    tracks.selectedId,
    frame,
    send,
  ]);

  // Mirror the effect tracks into the page; editing chrome, so not during a take.
  useEffect(() => {
    if (status !== 'ready') return;
    if (isPlaying || isExporting) return;
    void send({
      channel: OVERLAY_CHANNEL,
      op: 'render',
      frameWidth: frame.width,
      frameHeight: frame.height,
      regions: tracks.regions,
      cursors: tracks.cursors,
      selectedId: tracks.selectedId,
    });
  }, [
    status,
    isPlaying,
    isExporting,
    tracks.regions,
    tracks.cursors,
    tracks.selectedId,
    frame,
    send,
  ]);

  // ── editing commands ─────────────────────────────────────────────────────

  /** One gate for every editing command, from this window or the page. */
  const runCommand = useCallback(
    (command: EditCommand) => {
      if (isPlaying || isExporting) return;
      tracks.execute(command);
    },
    [isPlaying, isExporting, tracks.execute],
  );

  // The listener registers once, so it reads the command through a ref.
  const commandRef = useRef(runCommand);
  commandRef.current = runCommand;

  // Drags and shortcuts happen on the page, so both arrive from the overlay.
  useEffect(() => {
    const onMessage = (msg: unknown) => {
      if (!isEditNotice(msg)) return;
      const notice = msg as EditNotice;

      if (notice.op === 'select') {
        tracks.setSelectedId(notice.id);
        return;
      }
      if (notice.op === 'patch') {
        tracks.applyPatch(notice.id, notice.patch);
        return;
      }
      commandRef.current(notice.command);
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [tracks.setSelectedId, tracks.applyPatch]);

  // Shortcuts in the controller window. Inert while a text field has focus, so
  // the custom aspect-ratio inputs still work.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      const command = commandForKey(e);
      if (!command) return;
      e.preventDefault();
      runCommand(command);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [runCommand]);

  /** Select from the timeline; the effect may be off screen, so reveal it too. */
  const selectFromTimeline = useCallback(
    (id: string) => {
      tracks.setSelectedId(id);
      const region = tracks.regions.find((r) => r.id === id);
      if (region) {
        void send({
          channel: OVERLAY_CHANNEL,
          op: 'reveal',
          x: region.x,
          y: region.y,
          width: region.width,
          height: region.height,
        });
        return;
      }
      const cursor = tracks.cursors.find((c) => c.id === id);
      if (cursor) {
        // A cursor is a point; give it a box to centre on.
        const size = CURSOR_BASE_SIZE * cursor.scale;
        void send({
          channel: OVERLAY_CHANNEL,
          op: 'reveal',
          x: cursor.x - size / 2,
          y: cursor.y - size / 2,
          width: size,
          height: size,
        });
      }
    },
    [tracks.regions, tracks.cursors, tracks.setSelectedId, send],
  );

  // ── script editor windows ────────────────────────────────────────────────

  /** Windows already open, keyed by keyframe, so a second click focuses. */
  const editorWindowsRef = useRef(new Map<string, number>());

  /** Open a keyframe's editor, bottom-left at `anchor` (screen coordinates). */
  const openScriptEditor = useCallback(
    async (id: string, anchor?: { x: number; y: number }) => {
      tracks.setSelectedId(id);
      const existing = editorWindowsRef.current.get(id);
      if (existing != null) {
        try {
          await browser.windows.update(existing, { focused: true });
          return;
        } catch {
          editorWindowsRef.current.delete(id);
        }
      }

      const width = 720;
      const height = 480;
      const scr = screenOrigin();
      const placement = anchor
        ? {
            left: Math.round(
              Math.max(
                scr.left,
                Math.min(scr.left + scr.width - width, anchor.x),
              ),
            ),
            top: Math.round(
              Math.max(scr.top, Math.min(scr.top + scr.height - height, anchor.y - height)),
            ),
          }
        : {};

      try {
        const win = await browser.windows.create({
          url: `${browser.runtime.getURL('/script-editor.html')}?id=${id}`,
          type: 'popup',
          width,
          height,
          focused: true,
          ...placement,
        });
        if (win?.id != null) editorWindowsRef.current.set(id, win.id);
      } catch (err) {
        console.warn('[Dolly] could not open the script editor:', err);
      }
    },
    [tracks.setSelectedId],
  );

  useEffect(() => {
    const onRemoved = (windowId: number) => {
      for (const [id, open] of editorWindowsRef.current) {
        if (open === windowId) editorWindowsRef.current.delete(id);
      }
    };
    browser.windows.onRemoved.addListener(onRemoved);
    return () => browser.windows.onRemoved.removeListener(onRemoved);
  }, []);

  // The listener below registers once, so it reads the current setter via a ref.
  const setScriptCodeRef = useRef(tracks.setScriptCode);
  setScriptCodeRef.current = tracks.setScriptCode;

  // The editor is a separate page with no access to this state, so it loads and
  // saves its snippet through here.
  useEffect(() => {
    const onMessage = (
      msg: unknown,
      _sender: unknown,
      sendResponse: (response: ScriptResponse) => void,
    ) => {
      if (!isScriptRequest(msg)) return;
      const req = msg as ScriptRequest;

      if (req.op === 'load') {
        const script = tracks.scriptsRef.current.find((s) => s.id === req.id);
        sendResponse(
          script
            ? { ok: true, code: script.code }
            : { ok: false, error: 'that keyframe is gone' },
        );
        return true;
      }
      setScriptCodeRef.current(req.id, req.code);
      sendResponse({ ok: true });
      return true;
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [tracks.scriptsRef]);

  // Undo our footprint on close or reload. Best effort; the background repeats
  // it authoritatively on window close.
  useEffect(() => {
    const onPageHide = () => {
      void exporter.closeCurtain();
      // Editor windows save into this window's state, so they can't outlive it.
      for (const windowId of editorWindowsRef.current.values()) {
        void browser.windows.remove(windowId).catch(() => {});
      }
      editorWindowsRef.current.clear();
      if (target.tabId == null) return;
      void send({ channel: OVERLAY_CHANNEL, op: 'release' });
      void releaseTab(target.tabId);
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [target, send, exporter.closeCurtain]);

  return {
    regions: tracks.regions,
    cursors: tracks.cursors,
    scripts: tracks.scripts,
    selectedId: tracks.selectedId,
    isPlaying,
    isExporting,
    playheadTime: playback.playheadTime,
    status,
    windowFitted: workspace.windowFitted,
    shotDuration: tracks.shotDuration,
    canUndo: tracks.canUndo,
    canRedo: tracks.canRedo,
    undo: tracks.undo,
    redo: tracks.redo,
    selectFromTimeline,
    addRegion: tracks.addRegion,
    updateRegion: tracks.updateRegion,
    moveRegion: tracks.moveRegion,
    swapRegion: tracks.swapRegion,
    addCursor: tracks.addCursor,
    updateCursor: tracks.updateCursor,
    moveCursor: tracks.moveCursor,
    swapCursor: tracks.swapCursor,
    addScript: tracks.addScript,
    moveScript: tracks.moveScript,
    openScriptEditor,
    play: playback.play,
    stop: playback.stop,
    seek: playback.seek,
    startExport: exporter.startExport,
    stopExport: exporter.stopExport,
  };
}
