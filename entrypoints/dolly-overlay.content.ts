import { h, render } from 'preact';
import type { CursorPose } from '@/lib/cursor';
import type { CursorPoint, FocusRegion } from '@/lib/effects';
import { OverlayRoot } from '@/components/overlay/OverlayRoot';
import { OVERLAY_STYLES } from '@/components/overlay/overlayStyles';
import {
  DEFAULT_SETTLE_FRAMES,
  EDIT_CHANNEL,
  isOverlayRequest,
  type CameraTransform,
  type EditCommand,
  type EditNotice,
  type OverlayRequest,
  type OverlayResponse,
} from '@/lib/protocol';
import { commandForKey, isEditableTarget } from '@/lib/shortcuts';

/**
 * Dolly's footprint inside the recorded page: the camera, and the focus
 * rectangles you drag to place it. The tab is emulated to exactly the frame's
 * CSS size, so the viewport and the frame share a coordinate space and regions
 * need no translation.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  /** Not in the manifest: the background injects this only during a session. */
  registration: 'runtime',
  main() {
    if (window.self !== window.top) return;

    // Injection can repeat within a document, and a second copy would double
    // every listener.
    const globals = globalThis as Record<string, unknown>;
    if (globals.__dollyOverlayLoaded) return;
    globals.__dollyOverlayLoaded = true;

    const root = document.documentElement;

    type Saved = {
      transform: string;
      transformOrigin: string;
      willChange: string;
      overflow: string;
      scrollbarGutter: string;
      /** Frozen at session start, so a shot stays consistent. */
      scrollX: number;
      scrollY: number;
    };
    let saved: Saved | null = null;
    let host: HTMLElement | null = null;
    let mount: HTMLElement | null = null;
    /** Mirrors the controller's selection, so shortcuts know if one applies. */
    let selectedRegionId: string | null = null;

    const beginSession = () => {
      if (saved) return;
      saved = {
        transform: root.style.transform,
        transformOrigin: root.style.transformOrigin,
        willChange: root.style.willChange,
        overflow: root.style.overflow,
        scrollbarGutter: root.style.getPropertyValue('scrollbar-gutter'),
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      };
      // Scaling the root manufactures viewport overflow, whose scrollbars would
      // reflow the page mid-shot. The gutter stays reserved so a page that had
      // one keeps its content width.
      root.style.overflow = 'hidden';
      root.style.setProperty('scrollbar-gutter', 'stable');
      // Never hint `will-change: transform`: it pins the layer's raster scale,
      // which is the blur the camera is trying to avoid.
      root.style.willChange = 'auto';
    };

    const restoreStyles = () => {
      if (!saved) return;
      root.style.transform = saved.transform;
      root.style.transformOrigin = saved.transformOrigin;
      root.style.willChange = saved.willChange;
      root.style.overflow = saved.overflow;
      if (saved.scrollbarGutter) {
        root.style.setProperty('scrollbar-gutter', saved.scrollbarGutter);
      } else {
        root.style.removeProperty('scrollbar-gutter');
      }
      saved = null;
    };

    const ensureHost = (): HTMLElement => {
      if (host?.isConnected) return host;
      host = document.createElement('dolly-overlay');
      const shadow = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = OVERLAY_STYLES;
      mount = document.createElement('div');
      shadow.append(style, mount);
      // Appended to <html>, not <body>: an absolutely positioned child of the
      // root resolves against the initial containing block, so its coordinates
      // are document coordinates.
      root.appendChild(host);
      return host;
    };

    const teardownHost = () => {
      if (mount) render(null, mount);
      host?.remove();
      host = null;
      mount = null;
      selectedRegionId = null;
      scene = null;
      livePose = null;
      posing = false;
    };

    const frame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    /**
     * Wait for the transform to paint, plus `frames` more, so the compositor
     * can re-raster at the new scale before capture. The first is uncounted: a
     * rAF callback runs before its own frame paints.
     */
    const settle = async (frames: number) => {
      await frame();
      for (let i = 0; i < frames; i++) await frame();
    };

    const notify = (notice: EditNotice) => {
      // Fire-and-forget: nothing is listening if the controller has closed.
      void browser.runtime.sendMessage(notice).catch(() => {});
    };

    /** Kept between messages so a pose can repaint without a new render. */
    type Scene = {
      frameWidth: number;
      frameHeight: number;
      regions: FocusRegion[];
      cursors: CursorPoint[];
      selectedId: string | null;
    };
    let scene: Scene | null = null;
    let livePose: CursorPose | null = null;
    let posing = false;

    const paint = () => {
      if (!scene) return;
      ensureHost();
      if (!mount) return;
      // Regions are in document coordinates, so dragging is bounded by the
      // document rather than the frame.
      const boundsWidth = Math.max(root.scrollWidth, scene.frameWidth);
      const boundsHeight = Math.max(root.scrollHeight, scene.frameHeight);
      render(
        h(OverlayRoot, {
          frameWidth: scene.frameWidth,
          frameHeight: scene.frameHeight,
          boundsWidth,
          boundsHeight,
          regions: scene.regions,
          cursors: scene.cursors,
          selectedId: scene.selectedId,
          livePose,
          posing,
          onSelect: (id) => notify({ channel: EDIT_CHANNEL, op: 'select', id }),
          onChangeRegion: (id, patch) =>
            notify({ channel: EDIT_CHANNEL, op: 'patch', id, patch }),
          onChangeCursor: (id, patch) =>
            notify({ channel: EDIT_CHANNEL, op: 'patch', id, patch }),
        }),
        mount,
      );
    };

    const draw = (next: Scene) => {
      scene = next;
      paint();
    };

    /**
     * Put the page into one instant of the shot. A live pose means playback or
     * capture: editing chrome goes and the cursor appears instead. Returns
     * false for a camera that isn't finite.
     */
    const applyPose = (
      camera: CameraTransform,
      cursor: CursorPose | null,
    ): boolean => {
      const { s, tx, ty } = camera;
      if (![s, tx, ty].every((v) => Number.isFinite(v))) return false;
      posing = true;
      livePose = cursor;
      paint();
      beginSession();
      // Document space → root-box space, so the camera can pan anywhere in the
      // document without the page scrolling.
      const offsetX = tx + (saved?.scrollX ?? 0);
      const offsetY = ty + (saved?.scrollY ?? 0);
      root.style.transformOrigin = '0 0';
      root.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${s})`;
      return true;
    };

    const clearPose = () => {
      restoreStyles();
      posing = false;
      livePose = null;
      paint();
    };

    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!isOverlayRequest(msg)) return;
      const req = msg as OverlayRequest;
      const ok = (extra?: Partial<OverlayResponse>) =>
        sendResponse({ ok: true, ...extra });

      if (req.op === 'hello') {
        ok();
        return true;
      }

      if (req.op === 'measure') {
        // innerWidth, not clientWidth, which excludes any scrollbar.
        ok({
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
          documentWidth: root.scrollWidth,
          documentHeight: root.scrollHeight,
        });
        return true;
      }

      if (req.op === 'render') {
        selectedRegionId = req.selectedId;
        draw({
          frameWidth: req.frameWidth,
          frameHeight: req.frameHeight,
          regions: req.regions,
          cursors: req.cursors,
          selectedId: req.selectedId,
        });
        ok();
        return true;
      }

      if (req.op === 'reveal') {
        const left = window.scrollX;
        const top = window.scrollY;
        const right = left + window.innerWidth;
        const bottom = top + window.innerHeight;
        const visible =
          req.x >= left &&
          req.y >= top &&
          req.x + req.width <= right &&
          req.y + req.height <= bottom;
        if (!visible) {
          window.scrollTo({
            left: Math.max(
              0,
              Math.round(req.x + req.width / 2 - window.innerWidth / 2),
            ),
            top: Math.max(
              0,
              Math.round(req.y + req.height / 2 - window.innerHeight / 2),
            ),
            behavior: 'smooth',
          });
        }
        ok();
        return true;
      }

      if (req.op === 'pose') {
        if (req.camera === null) {
          clearPose();
          ok();
          return true;
        }
        if (!applyPose(req.camera, req.cursor)) {
          sendResponse({ ok: false, error: 'bad camera' });
          return true;
        }
        if (!req.settle) {
          ok();
          return true;
        }
        void settle(DEFAULT_SETTLE_FRAMES).then(() => ok());
        return true;
      }

      if (req.op === 'release') {
        restoreStyles();
        teardownHost();
        ok();
        return true;
      }

      return undefined;
    });

    /**
     * Editing shortcuts forwarded from the page, which holds focus while you
     * drag regions. Capture phase, to get ahead of the page's own handlers.
     */
    const SELECTION_COMMANDS: ReadonlySet<EditCommand> = new Set([
      'delete',
      'copy',
      'cut',
      'swap-left',
      'swap-right',
    ]);

    window.addEventListener(
      'keydown',
      (event) => {
        // Only while a session is running.
        if (!host) return;
        if (isEditableTarget(event.target)) return;

        const command = commandForKey(event);
        if (!command) return;

        // Copy/cut defer to the page whenever text is selected.
        const selection = window.getSelection();
        const hasText = Boolean(selection && !selection.isCollapsed);
        if (hasText && (command === 'copy' || command === 'cut')) return;
        if (SELECTION_COMMANDS.has(command) && !selectedRegionId) return;

        event.preventDefault();
        event.stopPropagation();
        notify({ channel: EDIT_CHANNEL, op: 'command', command });
      },
      { capture: true },
    );

    // A session outliving a navigation would leave the page transformed with
    // no controller aware of it.
    window.addEventListener('pagehide', () => {
      restoreStyles();
      teardownHost();
    });
  },
});
