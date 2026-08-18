import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  buildTimeline,
  cameraAt,
  toFramePoint,
  type Camera,
} from '@/lib/camera';
import { buildCursorTrack, cursorAt, type CursorPose } from '@/lib/cursor';
import type { CursorPoint, FocusRegion } from '@/lib/effects';
import type { OverlayResponse } from '@/lib/protocol';
import { openCursorInput, type CursorInput } from './cursorInput';
import type { SessionTarget, Size } from './layout';

export type UsePlaybackArgs = {
  status: 'connecting' | 'ready' | 'lost';
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  isExporting: boolean;
  regions: FocusRegion[];
  cursors: CursorPoint[];
  frame: Size;
  target: SessionTarget;
  shotDuration: number;
  setPose: (
    camera: Camera | null,
    cursor: CursorPose | null,
    settle: boolean,
  ) => Promise<OverlayResponse>;
  runScriptsBetween: (from: number, to: number) => Promise<void>;
  /** Forget which script keyframes have fired; called as a take starts. */
  resetTake: () => void;
};

/**
 * Previewing the shot in real time, in the live page.
 *
 * A shot with a cursor takes the debugger for the length of playback so the
 * pointer can be driven, and gives it straight back — so the banner is up only
 * while it is needed.
 */
export function usePlayback({
  status,
  isPlaying,
  setIsPlaying,
  isExporting,
  regions,
  cursors,
  frame,
  target,
  shotDuration,
  setPose,
  runScriptsBetween,
  resetTake,
}: UsePlaybackArgs) {
  const [playheadTime, setPlayheadTime] = useState(0);
  const rafRef = useRef<number | null>(null);
  const pointerRef = useRef<CursorInput | null>(null);
  /**
   * Bumped whenever a take starts or stops, so work that began during one can
   * tell it has been superseded. Taking the debugger is an await, and a stop
   * landing inside it would otherwise leave the attachment orphaned.
   */
  const takeRef = useRef(0);

  /** Hands the debugger back, which is what drops the banner. */
  const dropPointer = useCallback(() => {
    const pointer = pointerRef.current;
    pointerRef.current = null;
    void pointer?.release();
  }, []);

  const stop = useCallback(() => {
    takeRef.current++;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    dropPointer();
    void setPose(null, null, false);
    setIsPlaying(false);
  }, [setPose, setIsPlaying, dropPointer]);

  const play = useCallback(async () => {
    if (rafRef.current !== null || isExporting || status !== 'ready') return;
    const timeline = buildTimeline(regions, frame.width, frame.height);
    const cursorTrack = buildCursorTrack(cursors);
    // The shot runs as long as the longest track: a cursor move can outlast the
    // last camera hold.
    const duration = Math.max(timeline.duration, cursorTrack.duration);
    if (duration <= 0) return;

    const startFrom = playheadTime >= duration ? 0 : playheadTime;
    const take = ++takeRef.current;
    setPlayheadTime(startFrom);
    setIsPlaying(true);
    resetTake();

    // Only for a shot that has a cursor: nothing else here needs the debugger,
    // and its banner should not appear for a camera-only preview.
    if (target.tabId != null && cursorTrack.duration > 0) {
      const pointer = await openCursorInput(target.tabId, frame, { own: true });
      // Stopped, or restarted, while that was attaching. Hand the debugger
      // straight back — nothing else is going to — and leave the take that
      // superseded this one to own the state.
      if (takeRef.current !== take) {
        void pointer?.release();
        return;
      }
      pointerRef.current = pointer;
    }
    // Just below the start, so a keyframe sitting exactly there still fires.
    let lastTime = startFrom - 1e-6;

    const startWall = performance.now();
    const tick = () => {
      const t = startFrom + (performance.now() - startWall) / 1000;
      if (t >= duration) {
        setPlayheadTime(duration);
        rafRef.current = null;
        void runScriptsBetween(lastTime, duration);
        dropPointer();
        void setPose(null, null, false);
        setIsPlaying(false);
        return;
      }
      setPlayheadTime(t);
      // Not awaited: blocking the frame loop on a snippet would stutter the
      // camera. Export does await.
      void runScriptsBetween(lastTime, t);
      lastTime = t;
      const camera = cameraAt(timeline, t);
      const cursor = cursorAt(cursorTrack, t);
      void setPose(camera, cursor, false);
      // After the pose, so the hit test reads the camera it belongs to. A
      // frame's lag on the hover is invisible at playback speed.
      void pointerRef.current?.moveTo(
        cursor ? toFramePoint(camera, cursor) : null,
      );
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [
    regions,
    cursors,
    playheadTime,
    isExporting,
    status,
    frame,
    target,
    setPose,
    runScriptsBetween,
    resetTake,
    setIsPlaying,
    dropPointer,
  ]);

  const seek = useCallback(
    (t: number) => {
      if (isPlaying) return;
      setPlayheadTime(Math.max(0, Math.min(shotDuration, t)));
    },
    [shotDuration, isPlaying],
  );

  useEffect(() => {
    return () => {
      // Bumped first, so an attach still in flight releases itself.
      takeRef.current++;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      void pointerRef.current?.release();
    };
  }, []);

  return { playheadTime, play, stop, seek };
}
