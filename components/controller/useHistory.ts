import { useCallback, useRef, useState } from 'preact/hooks';

/** How many undo steps to keep. */
const HISTORY_LIMIT = 100;
/** Updates closer together than this count as one gesture. */
const HISTORY_COALESCE_MS = 450;

/** Undo history as whole snapshots; the caller defines what a snapshot is. */
export function useHistory<S>(snapshot: () => S, restore: (entry: S) => void) {
  const [past, setPast] = useState<S[]>([]);
  const [future, setFuture] = useState<S[]>([]);
  const coalesceUntilRef = useRef(0);

  /**
   * Record an undo point before the caller changes state. `coalesce` folds a
   * rapid run of updates into the single snapshot taken at the start.
   */
  const remember = useCallback(
    (coalesce: boolean) => {
      const now = Date.now();
      const withinRun = coalesce && now < coalesceUntilRef.current;
      coalesceUntilRef.current = now + HISTORY_COALESCE_MS;
      // Same reference when already empty: a drag mustn't queue a state
      // change per pointer move.
      setFuture((entries) => (entries.length === 0 ? entries : []));
      if (withinRun) return;
      setPast((entries) => [...entries, snapshot()].slice(-HISTORY_LIMIT));
    },
    [snapshot],
  );

  const undo = useCallback(() => {
    if (past.length === 0) return;
    setFuture((entries) => [...entries, snapshot()]);
    setPast(past.slice(0, -1));
    restore(past[past.length - 1]!);
    coalesceUntilRef.current = 0;
  }, [past, snapshot, restore]);

  const redo = useCallback(() => {
    if (future.length === 0) return;
    setPast((entries) => [...entries, snapshot()]);
    setFuture(future.slice(0, -1));
    restore(future[future.length - 1]!);
    coalesceUntilRef.current = 0;
  }, [future, snapshot, restore]);

  /**
   * Rewrite every stored entry in place, without counting as an edit: snapshots
   * left in an old frame's coordinates would restore the wrong geometry.
   */
  const rewrite = useCallback((carry: (entry: S) => S) => {
    setPast((entries) => entries.map(carry));
    setFuture((entries) => entries.map(carry));
  }, []);

  return {
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    remember,
    undo,
    redo,
    rewrite,
  };
}
