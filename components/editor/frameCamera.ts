import {
  CAM_REQUEST,
  DEFAULT_SETTLE_FRAMES,
  isCamAck,
  type CamRequest,
} from './camProtocol';
import type { Camera } from './camera';

const CONNECT_TIMEOUT_MS = 500;
const CONNECT_ATTEMPTS = 4;
const SETTLE_TIMEOUT_MS = 1000;

export type FrameCamera = {
  /**
   * Hand-shake with the content script inside the preview iframe. Resolves
   * false when the frame has no camera (about:blank, chrome:// URLs, or any
   * page where content scripts can't run) — the caller decides what that
   * means, since there is no crisp fallback.
   */
  connect(): Promise<boolean>;
  isConnected(): boolean;
  /** Apply a camera without waiting. For playback. */
  set(camera: Camera): void;
  /**
   * Apply a camera and wait until the frame has re-rastered with it. For
   * capture. Resolves false if the frame didn't ack in time — the frame that
   * follows may not be fully settled.
   */
  setAndSettle(camera: Camera, settleFrames?: number): Promise<boolean>;
  /** End the session and restore the page. */
  release(): void;
  dispose(): void;
};

export function createFrameCamera(
  getFrame: () => HTMLIFrameElement | null,
): FrameCamera {
  const pending = new Map<number, () => void>();
  let seq = 0;
  let connected = false;
  let listening = false;
  let lastPosted: Camera | null = null;

  const onMessage = (event: MessageEvent) => {
    if (!isCamAck(event.data)) return;
    if (event.source !== getFrame()?.contentWindow) return;
    const resolve = pending.get(event.data.seq);
    if (resolve) {
      pending.delete(event.data.seq);
      resolve();
    }
  };

  const listen = () => {
    if (listening) return;
    window.addEventListener('message', onMessage);
    listening = true;
  };

  // Target origin is `*`: the previewed page's origin isn't knowable up front
  // and changes on navigation. The payload is a transform, and the content
  // script only accepts requests whose sender origin is the extension's.
  const post = (req: CamRequest) => {
    const frame = getFrame();
    if (!frame?.contentWindow) return false;
    frame.contentWindow.postMessage(req, '*');
    return true;
  };

  /** Post and wait for the matching ack, or give up after `timeoutMs`. */
  const postAndWait = (
    build: (seq: number) => CamRequest,
    timeoutMs: number,
  ): Promise<boolean> => {
    listen();
    const id = ++seq;
    return new Promise<boolean>((resolve) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        resolve(false);
      }, timeoutMs);
      pending.set(id, () => {
        window.clearTimeout(timer);
        resolve(true);
      });
      if (!post(build(id))) {
        window.clearTimeout(timer);
        pending.delete(id);
        resolve(false);
      }
    });
  };

  return {
    async connect() {
      lastPosted = null;
      // The iframe may still be loading, in which case its document doesn't
      // have our listener yet. Retry rather than declare it camera-less.
      for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
        const ok = await postAndWait(
          (id) => ({ channel: CAM_REQUEST, op: 'connect', seq: id }),
          CONNECT_TIMEOUT_MS,
        );
        if (ok) {
          connected = true;
          return true;
        }
      }
      connected = false;
      return false;
    },

    isConnected() {
      return connected;
    },

    set(camera) {
      if (
        lastPosted &&
        lastPosted.scale === camera.scale &&
        lastPosted.translateX === camera.translateX &&
        lastPosted.translateY === camera.translateY
      ) {
        return;
      }
      const posted = post({
        channel: CAM_REQUEST,
        op: 'set',
        seq: ++seq,
        s: camera.scale,
        tx: camera.translateX,
        ty: camera.translateY,
        ack: false,
      });
      if (posted) lastPosted = camera;
    },

    setAndSettle(camera, settleFrames = DEFAULT_SETTLE_FRAMES) {
      lastPosted = camera;
      return postAndWait(
        (id) => ({
          channel: CAM_REQUEST,
          op: 'set',
          seq: id,
          s: camera.scale,
          tx: camera.translateX,
          ty: camera.translateY,
          ack: true,
          settleFrames,
        }),
        SETTLE_TIMEOUT_MS,
      );
    },

    release() {
      lastPosted = null;
      connected = false;
      post({ channel: CAM_REQUEST, op: 'release', seq: ++seq });
    },

    dispose() {
      pending.forEach((resolve) => resolve());
      pending.clear();
      if (listening) {
        window.removeEventListener('message', onMessage);
        listening = false;
      }
    },
  };
}
