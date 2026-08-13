import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import {
  DEFAULT_CURSOR_DURATION,
  DEFAULT_CURSOR_ICON,
  DEFAULT_JS_CODE,
  DEFAULT_REGION_DURATION,
  keyframeAt,
  MIN_REGION_WIDTH,
  TRANSITION_GAP,
  type CursorPoint,
  type FocusRegion,
  type JsKeyframe,
} from '@/lib/effects';
import {
  moveSpan,
  nextFreeStart,
  swapWithNeighbour,
  trackEnd,
  type TimeSpan,
} from '@/lib/timeline';
import type { EditCommand, EffectPatch } from '@/lib/protocol';
import type { Measurement, Size } from './layout';
import { useHistory } from './useHistory';

/** One undo step: every effect track as it stood. */
type Snapshot = {
  regions: FocusRegion[];
  cursors: CursorPoint[];
  scripts: JsKeyframe[];
};

/** A new region centred on the viewport, in document space (scroll included). */
function makeDefaultRegion(
  existing: FocusRegion[],
  frameWidth: number,
  frameHeight: number,
  scrollX: number,
  scrollY: number,
): FocusRegion {
  const startTime = nextFreeStart(existing, TRANSITION_GAP);

  const aspect = frameWidth / frameHeight;
  let width = frameWidth * 0.6;
  let height = width / aspect;
  if (height > frameHeight * 0.8) {
    height = frameHeight * 0.8;
    width = height * aspect;
  }

  return {
    id: crypto.randomUUID(),
    kind: 'focus',
    startTime,
    endTime: startTime + DEFAULT_REGION_DURATION,
    x: scrollX + (frameWidth - width) / 2,
    y: scrollY + (frameHeight - height) / 2,
    width,
    height,
  };
}

type SpanSetter<T> = (updater: (prev: T[]) => T[]) => void;

/**
 * Patch, retime and reorder, bound to one span track's setter. All three
 * coalesce history entries, since dragging and resizing stream updates.
 */
function makeSpanOps<T extends TimeSpan>(
  set: SpanSetter<T>,
  remember: (coalesce: boolean) => void,
) {
  return {
    update(id: string, patch: Partial<T>) {
      remember(true);
      set((prev) =>
        prev.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
    },
    move(id: string, startTime: number) {
      remember(true);
      set((prev) => {
        const patch = moveSpan(prev, id, startTime);
        if (!patch) return prev;
        return prev.map((item) =>
          item.id === id
            ? { ...item, startTime: patch.startTime, endTime: patch.endTime }
            : item,
        );
      });
    },
    swap(id: string, direction: -1 | 1) {
      remember(true);
      set((prev) => {
        const patches = swapWithNeighbour(prev, id, direction);
        if (patches.length === 0) return prev;
        return prev.map((item) => {
          const patch = patches.find((p) => p.id === item.id);
          return patch
            ? { ...item, startTime: patch.startTime, endTime: patch.endTime }
            : item;
        });
      });
    },
  };
}

export type UseTracksArgs = {
  /** The frame's current size, for centring new effects in the viewport. */
  frame: Size;
  measureViewport: () => Promise<Measurement | null>;
};

/**
 * Everything the user edits: the three effect tracks, the selection, the
 * clipboard, and the undo history spanning them all.
 */
export function useTracks({ frame, measureViewport }: UseTracksArgs) {
  const [regions, setRegions] = useState<FocusRegion[]>([]);
  const [cursors, setCursors] = useState<CursorPoint[]>([]);
  const [scripts, setScripts] = useState<JsKeyframe[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Tagged by kind, so one clipboard serves every effect. */
  const [clipboard, setClipboard] = useState<
    | { kind: 'focus'; item: FocusRegion }
    | { kind: 'cursor'; item: CursorPoint }
    | { kind: 'js'; item: JsKeyframe }
    | null
  >(null);

  /** Read by mutators that must not close over stale state. */
  const regionsRef = useRef(regions);
  regionsRef.current = regions;
  const cursorsRef = useRef(cursors);
  cursorsRef.current = cursors;
  const scriptsRef = useRef(scripts);
  scriptsRef.current = scripts;

  const snapshot = useCallback(
    (): Snapshot => ({
      regions: regionsRef.current,
      cursors: cursorsRef.current,
      scripts: scriptsRef.current,
    }),
    [],
  );

  const restore = useCallback((entry: Snapshot) => {
    setRegions(entry.regions);
    setCursors(entry.cursors);
    setScripts(entry.scripts);
    // The selection may name an effect that no longer exists in the snapshot.
    const ids = new Set([
      ...entry.regions.map((r) => r.id),
      ...entry.cursors.map((c) => c.id),
      ...entry.scripts.map((s) => s.id),
    ]);
    setSelectedId((id) => (id && ids.has(id) ? id : null));
  }, []);

  const history = useHistory(snapshot, restore);
  const { remember } = history;

  const regionOps = useMemo(
    () => makeSpanOps<FocusRegion>(setRegions, remember),
    [remember],
  );
  const cursorOps = useMemo(
    () => makeSpanOps<CursorPoint>(setCursors, remember),
    [remember],
  );

  // ── adding effects ───────────────────────────────────────────────────────

  const addRegion = useCallback(async () => {
    // Ask for the scroll offset now rather than tracking it: this is the only
    // moment it matters.
    const view = await measureViewport();
    const next = makeDefaultRegion(
      regionsRef.current,
      frame.width,
      frame.height,
      view?.scrollX ?? 0,
      view?.scrollY ?? 0,
    );
    remember(false);
    setRegions((prev) => [...prev, next]);
    setSelectedId(next.id);
  }, [frame, measureViewport, remember]);

  const addCursor = useCallback(async () => {
    const view = await measureViewport();
    const start = nextFreeStart(cursorsRef.current, TRANSITION_GAP);
    const next: CursorPoint = {
      id: crypto.randomUUID(),
      kind: 'cursor',
      startTime: start,
      endTime: start + DEFAULT_CURSOR_DURATION,
      x: (view?.scrollX ?? 0) + frame.width / 2,
      y: (view?.scrollY ?? 0) + frame.height / 2,
      scale: 1,
      icon: DEFAULT_CURSOR_ICON,
    };
    remember(false);
    setCursors((prev) => [...prev, next]);
    setSelectedId(next.id);
  }, [frame, measureViewport, remember]);

  const addScript = useCallback(() => {
    const time = nextFreeStart(scriptsRef.current, TRANSITION_GAP);
    const next: JsKeyframe = {
      id: crypto.randomUUID(),
      kind: 'js',
      ...keyframeAt(time),
      code: DEFAULT_JS_CODE,
    };
    remember(false);
    setScripts((prev) => [...prev, next]);
    setSelectedId(next.id);
  }, [remember]);

  // ── script keyframes ─────────────────────────────────────────────────────

  /** Move a keyframe in time. No neighbour clamping: instants can't overlap. */
  const moveScript = useCallback(
    (id: string, time: number) => {
      remember(true);
      setScripts((prev) =>
        prev.map((s) => (s.id === id ? { ...s, ...keyframeAt(time) } : s)),
      );
    },
    [remember],
  );

  const setScriptCode = useCallback(
    (id: string, code: string) => {
      remember(false);
      setScripts((prev) =>
        prev.map((s) => (s.id === id ? { ...s, code } : s)),
      );
    },
    [remember],
  );

  /**
   * Show or hide an effect in the page. Editor-only: the shot is unchanged, so
   * a hidden region still moves the camera and a hidden cursor still records.
   *
   * Not `update`, which coalesces for drags — a toggle is one discrete step.
   */
  const toggleHidden = useCallback(
    (id: string) => {
      remember(false);
      const flip = <T extends { id: string; hidden?: boolean }>(prev: T[]) =>
        prev.some((item) => item.id === id)
          ? prev.map((item) =>
              item.id === id ? { ...item, hidden: !item.hidden } : item,
            )
          : prev;
      setRegions(flip);
      setCursors(flip);
    },
    [remember],
  );

  // ── clipboard ────────────────────────────────────────────────────────────

  const deleteSelected = useCallback(() => {
    if (!selectedId) return;
    remember(false);
    setRegions((prev) => prev.filter((r) => r.id !== selectedId));
    setCursors((prev) => prev.filter((c) => c.id !== selectedId));
    setScripts((prev) => prev.filter((s) => s.id !== selectedId));
    setSelectedId(null);
  }, [selectedId, remember]);

  const copySelected = useCallback(() => {
    const region = regions.find((r) => r.id === selectedId);
    if (region) {
      setClipboard({ kind: 'focus', item: { ...region } });
      return true;
    }
    const cursor = cursors.find((c) => c.id === selectedId);
    if (cursor) {
      setClipboard({ kind: 'cursor', item: { ...cursor } });
      return true;
    }
    const script = scripts.find((s) => s.id === selectedId);
    if (script) {
      setClipboard({ kind: 'js', item: { ...script } });
      return true;
    }
    return false;
  }, [regions, cursors, scripts, selectedId]);

  const cutSelected = useCallback(() => {
    if (copySelected()) deleteSelected();
  }, [copySelected, deleteSelected]);

  const swapSelected = useCallback(
    (direction: -1 | 1) => {
      if (!selectedId) return;
      if (regions.some((r) => r.id === selectedId)) {
        regionOps.swap(selectedId, direction);
      } else if (cursors.some((c) => c.id === selectedId)) {
        cursorOps.swap(selectedId, direction);
      }
    },
    [selectedId, regions, cursors, regionOps, cursorOps],
  );

  /** Paste lands after everything on *its own* track, keeping duration and size. */
  const pasteClipboard = useCallback(() => {
    if (!clipboard) return;
    const length = clipboard.item.endTime - clipboard.item.startTime;
    const id = crypto.randomUUID();
    remember(false);

    if (clipboard.kind === 'focus') {
      const start = nextFreeStart(regionsRef.current, TRANSITION_GAP);
      setRegions((prev) => [
        ...prev,
        { ...clipboard.item, id, startTime: start, endTime: start + length },
      ]);
    } else if (clipboard.kind === 'cursor') {
      const start = nextFreeStart(cursorsRef.current, TRANSITION_GAP);
      setCursors((prev) => [
        ...prev,
        { ...clipboard.item, id, startTime: start, endTime: start + length },
      ]);
    } else {
      const time = nextFreeStart(scriptsRef.current, TRANSITION_GAP);
      setScripts((prev) => [
        ...prev,
        { ...clipboard.item, id, ...keyframeAt(time) },
      ]);
    }
    setSelectedId(id);
  }, [clipboard, remember]);

  /** Every editing command; the caller decides when they're allowed at all. */
  const execute = useCallback(
    (command: EditCommand) => {
      switch (command) {
        case 'delete':
          deleteSelected();
          break;
        case 'copy':
          copySelected();
          break;
        case 'cut':
          cutSelected();
          break;
        case 'paste':
          pasteClipboard();
          break;
        case 'swap-left':
          swapSelected(-1);
          break;
        case 'swap-right':
          swapSelected(1);
          break;
        case 'undo':
          history.undo();
          break;
        case 'redo':
          history.redo();
          break;
      }
    },
    [
      deleteSelected,
      copySelected,
      cutSelected,
      pasteClipboard,
      swapSelected,
      history.undo,
      history.redo,
    ],
  );

  /**
   * Patch from an in-page drag. Each track returns its array by reference when
   * the id isn't its own; a fresh array would re-render the page every frame.
   */
  const applyPatch = useCallback(
    (id: string, patch: EffectPatch) => {
      remember(true);
      setRegions((prev) =>
        prev.some((r) => r.id === id)
          ? prev.map((r) => (r.id === id ? { ...r, ...patch } : r))
          : prev,
      );
      setCursors((prev) =>
        prev.some((c) => c.id === id)
          ? prev.map((c) => (c.id === id ? { ...c, ...patch } : c))
          : prev,
      );
    },
    [remember],
  );

  // ── reflow ───────────────────────────────────────────────────────────────

  /** Previous frame and document sizes, for carrying regions across a resize. */
  const prevFrameRef = useRef<Size | null>(null);
  const prevDocRef = useRef<Size | null>(null);

  /**
   * Carry the tracks across a frame-size change. Size scales with the frame so a
   * region's zoom holds; its centre scales with the *document*, since narrowing
   * the viewport reflows the page taller and pushes content down in proportion.
   */
  const remapTracks = useCallback(
    (nextFrame: Size, nextDoc: Size | null) => {
      const prevFrame = prevFrameRef.current;
      const prevDoc = prevDocRef.current;
      prevFrameRef.current = nextFrame;
      if (nextDoc) prevDocRef.current = nextDoc;

      if (!prevFrame || prevFrame.width <= 0 || nextFrame.width <= 0) return;
      if (
        prevFrame.width === nextFrame.width &&
        prevFrame.height === nextFrame.height
      ) {
        return;
      }

      const sizeScale = nextFrame.width / prevFrame.width;
      // Fall back to the frame's ratio if the document couldn't be measured.
      const usable =
        prevDoc && nextDoc && prevDoc.width > 0 && prevDoc.height > 0;
      const posScaleX = usable ? nextDoc!.width / prevDoc!.width : sizeScale;
      const posScaleY = usable ? nextDoc!.height / prevDoc!.height : sizeScale;
      const aspect = nextFrame.width / nextFrame.height;

      const rescale = (list: FocusRegion[]) =>
        list.map((r) => {
          const centerX = (r.x + r.width / 2) * posScaleX;
          const centerY = (r.y + r.height / 2) * posScaleY;
          let width = Math.min(
            Math.max(r.width * sizeScale, MIN_REGION_WIDTH),
            nextFrame.width,
          );
          let height = width / aspect;
          if (height > nextFrame.height) {
            height = nextFrame.height;
            width = height * aspect;
          }
          return {
            ...r,
            width,
            height,
            x: Math.max(0, centerX - width / 2),
            y: Math.max(0, centerY - height / 2),
          };
        });

      // Cursors are points, so only position moves with the reflow — their scale
      // is a size in page pixels, unaffected by the window.
      const shift = (list: CursorPoint[]) =>
        list.map((c) => ({
          ...c,
          x: c.x * posScaleX,
          y: c.y * posScaleY,
        }));

      setRegions(rescale);
      setCursors(shift);
      // A resize isn't an edit, so the snapshots are rewritten in place rather
      // than pushed. Script keyframes are purely temporal and carry unchanged.
      history.rewrite((entry) => ({
        regions: rescale(entry.regions),
        cursors: shift(entry.cursors),
        scripts: entry.scripts,
      }));
    },
    [history.rewrite],
  );

  /** How long the shot runs: the end of the longest track, whichever that is. */
  const shotDuration = useMemo(
    () => Math.max(trackEnd(regions), trackEnd(cursors), trackEnd(scripts)),
    [regions, cursors, scripts],
  );

  return {
    regions,
    cursors,
    scripts,
    selectedId,
    setSelectedId,
    regionsRef,
    cursorsRef,
    scriptsRef,
    shotDuration,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undo: history.undo,
    redo: history.redo,
    addRegion,
    updateRegion: regionOps.update,
    moveRegion: regionOps.move,
    swapRegion: regionOps.swap,
    addCursor,
    updateCursor: cursorOps.update,
    moveCursor: cursorOps.move,
    swapCursor: cursorOps.swap,
    addScript,
    moveScript,
    setScriptCode,
    toggleHidden,
    execute,
    applyPatch,
    remapTracks,
  };
}
