import type { CursorPose } from '@/lib/cursor';
import type { CursorPoint, FocusRegion } from '@/lib/effects';

/**
 * Messaging between the three Dolly contexts. The controller popup owns all
 * editing state and talks to the target page's overlay over `tabs.sendMessage`;
 * the background only launches sessions and cleans up after them.
 */

export const OVERLAY_CHANNEL = 'dolly:overlay';
export const EDIT_CHANNEL = 'dolly:edit';
export const SCRIPT_CHANNEL = 'dolly:script';
export const EXPORT_CHANNEL = 'dolly:export';

/**
 * Painted frames the page waits out before reporting a pose settled, on top of
 * the one that gets the change on screen (so 0 is legal). Each costs ~17ms per
 * exported frame, against the risk of capturing an un-rastered frame.
 */
export const DEFAULT_SETTLE_FRAMES = 1;

export type CameraTransform = {
  s: number;
  /** Camera translation, in the page's CSS pixels. */
  tx: number;
  ty: number;
};

// ── controller → target page ──────────────────────────────────────────────

export type OverlayRequest =
  /** Is the overlay listening in this tab? */
  | { channel: typeof OVERLAY_CHANNEL; op: 'hello' }
  /** Report the visual viewport, scroll offset and document extents. */
  | { channel: typeof OVERLAY_CHANNEL; op: 'measure' }
  /** Draw (or update) the editing chrome: focus rectangles and cursor handles. */
  | {
      channel: typeof OVERLAY_CHANNEL;
      op: 'render';
      frameWidth: number;
      frameHeight: number;
      regions: FocusRegion[];
      cursors: CursorPoint[];
      selectedId: string | null;
    }
  /**
   * Set the shot's pose for one instant, or clear it with `camera: null`.
   * Camera and cursor travel together because a capture must see both sampled
   * from the same moment. With `settle`, the response is withheld until the
   * page re-rasters. The translation is in document coordinates.
   */
  | {
      channel: typeof OVERLAY_CHANNEL;
      op: 'pose';
      camera: CameraTransform | null;
      cursor: CursorPose | null;
      settle: boolean;
    }
  /** Scroll a region into view, if it isn't already. Document coordinates. */
  | {
      channel: typeof OVERLAY_CHANNEL;
      op: 'reveal';
      x: number;
      y: number;
      width: number;
      height: number;
    }
  /** End the session: restore every style we touched and unmount. */
  | { channel: typeof OVERLAY_CHANNEL; op: 'release' };

export type OverlayResponse = {
  ok: boolean;
  error?: string;
  /** All set by `measure`. */
  innerWidth?: number;
  innerHeight?: number;
  scrollX?: number;
  scrollY?: number;
  documentWidth?: number;
  documentHeight?: number;
};

// ── target page → controller ──────────────────────────────────────────────

/** Editing actions the recorded page can ask for; it holds focus while you drag. */
export type EditCommand =
  | 'copy'
  | 'cut'
  | 'paste'
  | 'delete'
  | 'swap-left'
  | 'swap-right'
  | 'undo'
  | 'redo';

/** Fields an in-page drag can change, across every effect kind. */
export type EffectPatch = Partial<
  Pick<FocusRegion, 'startTime' | 'endTime' | 'x' | 'y' | 'width' | 'height'>
> &
  Partial<Pick<CursorPoint, 'scale' | 'icon'>>;

export type EditNotice =
  | { channel: typeof EDIT_CHANNEL; op: 'select'; id: string }
  | {
      channel: typeof EDIT_CHANNEL;
      op: 'patch';
      id: string;
      patch: EffectPatch;
    }
  | { channel: typeof EDIT_CHANNEL; op: 'command'; command: EditCommand };

// ── script editor window ↔ controller ─────────────────────────────────────

/**
 * The editor is its own extension page and can't share state with the
 * controller, so it asks for the snippet it was opened on and hands the edited
 * text back. The controller remains the only owner of the keyframe list.
 */
export type ScriptRequest =
  | { channel: typeof SCRIPT_CHANNEL; op: 'load'; id: string }
  | { channel: typeof SCRIPT_CHANNEL; op: 'save'; id: string; code: string };

export type ScriptResponse = {
  ok: boolean;
  code?: string;
  error?: string;
};

// ── export curtain ↔ controller ───────────────────────────────────────────

/**
 * The curtain is a window laid over the page for the length of an export: it
 * hides the capture's visual churn, blocks stray clicks, and reports progress.
 */
/**
 * How an export ended. `cancelled` and `failed` are kept apart so a crash isn't
 * announced as though the user had stopped it.
 */
export type ExportOutcome = 'done' | 'cancelled' | 'failed';

export type ExportNotice =
  | {
      channel: typeof EXPORT_CHANNEL;
      op: 'progress';
      done: number;
      total: number;
    }
  | {
      channel: typeof EXPORT_CHANNEL;
      op: 'finished';
      outcome: ExportOutcome;
      summary: string;
    }
  /** Curtain → controller: the user asked to stop. */
  | { channel: typeof EXPORT_CHANNEL; op: 'cancel' };

export function isExportNotice(value: unknown): value is ExportNotice {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { channel?: unknown }).channel === EXPORT_CHANNEL
  );
}

export function isScriptRequest(value: unknown): value is ScriptRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { channel?: unknown }).channel === SCRIPT_CHANNEL
  );
}

export function isOverlayRequest(value: unknown): value is OverlayRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { channel?: unknown }).channel === OVERLAY_CHANNEL
  );
}

export function isEditNotice(value: unknown): value is EditNotice {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { channel?: unknown }).channel === EDIT_CHANNEL
  );
}
