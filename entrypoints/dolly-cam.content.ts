import {
  CAM_ACK,
  DEFAULT_SETTLE_FRAMES,
  isCamRequest,
  type CamAck,
  type CamRequest,
} from '@/components/editor/camProtocol';

/**
 * The camera, applied inside the recorded page.
 *
 * Runs in every frame and stays inert until the editor page posts a
 * `dolly:cam` request. The transform goes on this document's own root
 * element so this frame's compositor sees it and rasters at the effective
 * scale — a transform applied by the parent to the iframe element would just
 * stretch an already-rastered texture, which is what makes zoomed exports
 * look soft.
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_start',
  main() {
    // Only ever relevant when embedded — the editor previews us in an iframe.
    if (window.self === window.top) return;

    const editorOrigin = new URL(browser.runtime.getURL('/')).origin;
    const root = document.documentElement;

    type Saved = {
      transform: string;
      transformOrigin: string;
      willChange: string;
      overflow: string;
      scrollbarGutter: string;
    };
    let saved: Saved | null = null;

    const beginSession = () => {
      if (saved) return;
      saved = {
        transform: root.style.transform,
        transformOrigin: root.style.transformOrigin,
        willChange: root.style.willChange,
        overflow: root.style.overflow,
        scrollbarGutter: root.style.getPropertyValue('scrollbar-gutter'),
      };

      // Scaling the root manufactures viewport overflow even on pages that
      // had none, and the resulting root scrollbars would shrink this frame's
      // layout viewport — reflowing the page mid-shot. Suppress them, but
      // reserve the gutter so a page that *did* have a scrollbar keeps the
      // exact same content width it had in the editor preview.
      root.style.overflow = 'hidden';
      root.style.setProperty('scrollbar-gutter', 'stable');

      // Never hint `will-change: transform` here: it pins the layer's raster
      // scale, which is precisely the blur we're trying to avoid. Clear it in
      // case the page set it on the root itself.
      root.style.willChange = 'auto';
    };

    const endSession = () => {
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

    const frame = () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    /**
     * Wait for the compositor to have actually re-rastered at the new scale.
     * Chrome picks a layer's raster scale on commit, so a settled camera needs
     * more than the one frame that publishes the style change: we ride out
     * `frames` animation frames, yield to the task queue so any commit that
     * last frame scheduled can land, then confirm one more frame.
     */
    const settle = async (frames: number) => {
      for (let i = 0; i < frames; i++) await frame();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await frame();
    };

    const applyCamera = (s: number, tx: number, ty: number) => {
      beginSession();
      root.style.transformOrigin = '0 0';
      root.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    };

    const finite = (...values: unknown[]) =>
      values.every((v) => typeof v === 'number' && Number.isFinite(v));

    const reply = (source: MessageEventSource | null, seq: number) => {
      const ack: CamAck = { channel: CAM_ACK, seq };
      (source as Window | null)?.postMessage(ack, editorOrigin);
    };

    window.addEventListener('message', (event) => {
      if (event.origin !== editorOrigin) return;
      if (!isCamRequest(event.data)) return;
      const req = event.data as CamRequest;

      if (req.op === 'connect') {
        beginSession();
        void frame().then(() => reply(event.source, req.seq));
        return;
      }

      if (req.op === 'release') {
        endSession();
        reply(event.source, req.seq);
        return;
      }

      if (!finite(req.s, req.tx, req.ty)) return;
      applyCamera(req.s, req.tx, req.ty);

      if (req.ack) {
        void settle(req.settleFrames ?? DEFAULT_SETTLE_FRAMES).then(() =>
          reply(event.source, req.seq),
        );
      }
    });
  },
});
