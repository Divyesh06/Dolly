/**
 * Wire protocol between the editor page and the `dolly-cam` content script
 * running inside the preview iframe.
 *
 * The preview iframe is always cross-origin (extension page → site URL), so
 * it is always an out-of-process iframe. A transform on the iframe *element*
 * is composited by the parent as a stretched texture — the child never
 * re-rasters, which is why the camera must be applied to the child's own
 * document. This is the only channel that does it.
 */

export const CAM_REQUEST = 'dolly:cam';
export const CAM_ACK = 'dolly:cam:ack';

/** Compositor frames the child waits out before acking a settled camera. */
export const DEFAULT_SETTLE_FRAMES = 3;

export type CamRequest =
  /** Start a session: stash the child's styles, suppress its root scrollbar. */
  | { channel: typeof CAM_REQUEST; op: 'connect'; seq: number }
  /** Apply a camera. Acked after paint when `ack` is set. */
  | {
      channel: typeof CAM_REQUEST;
      op: 'set';
      seq: number;
      /** Camera scale. */
      s: number;
      /** Camera translation, in the child's CSS pixels. */
      tx: number;
      ty: number;
      ack: boolean;
      settleFrames?: number;
    }
  /** End the session and restore everything we touched. */
  | { channel: typeof CAM_REQUEST; op: 'release'; seq: number };

export type CamAck = {
  channel: typeof CAM_ACK;
  seq: number;
};

export function isCamRequest(value: unknown): value is CamRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { channel?: unknown }).channel === CAM_REQUEST
  );
}

export function isCamAck(value: unknown): value is CamAck {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { channel?: unknown }).channel === CAM_ACK &&
    typeof (value as { seq?: unknown }).seq === 'number'
  );
}
