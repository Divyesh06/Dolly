import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { buildTimeline, cameraAt, type Camera } from '@/lib/camera';
import { buildCursorTrack, cursorAt, type CursorPose } from '@/lib/cursor';
import type { CursorPoint, FocusRegion } from '@/lib/effects';
import type { OverlayResponse } from '@/lib/protocol';
import type { Size } from './layout';

export type UsePlaybackArgs = {
  status: 'connecting' | 'ready' | 'lost';
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  isExporting: boolean;
  regions: FocusRegion[];
  cursors: CursorPoint[];
  frame: Size;
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

/** Previewing the shot in real time, in the live page. */
export function usePlayback({
  status,
  isPlaying,
  setIsPlaying,
  isExporting,
  regions,
  cursors,
  frame,
  shotDuration,
  setPose,
  runScriptsBetween,
  resetTake,
}: UsePlaybackArgs) {
  const [playheadTime, setPlayheadTime] = useState(0);
  const rafRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    void setPose(null, null, false);
    setIsPlaying(false);
  }, [setPose, setIsPlaying]);

  const play = useCallback(async () => {
    if (rafRef.current !== null || isExporting || status !== 'ready') return;
    const timeline = buildTimeline(regions, frame.width, frame.height);
    const cursorTrack = buildCursorTrack(cursors);
    // The shot runs as long as the longest track: a cursor move can outlast the
    // last camera hold.
    const duration = Math.max(timeline.duration, cursorTrack.duration);
    if (duration <= 0) return;

    const startFrom = playheadTime >= duration ? 0 : playheadTime;
    setPlayheadTime(startFrom);
    setIsPlaying(true);
    resetTake();
    // Just below the start, so a keyframe sitting exactly there still fires.
    let lastTime = startFrom - 1e-6;

    const startWall = performance.now();
    const tick = () => {
      const t = startFrom + (performance.now() - startWall) / 1000;
      if (t >= duration) {
        setPlayheadTime(duration);
        rafRef.current = null;
        void runScriptsBetween(lastTime, duration);
        void setPose(null, null, false);
        setIsPlaying(false);
        return;
      }
      setPlayheadTime(t);
      // Not awaited: blocking the frame loop on a snippet would stutter the
      // camera. Export does await.
      void runScriptsBetween(lastTime, t);
      lastTime = t;
      void setPose(cameraAt(timeline, t), cursorAt(cursorTrack, t), false);
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
    setPose,
    runScriptsBetween,
    resetTake,
    setIsPlaying,
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
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return { playheadTime, play, stop, seek };
}
