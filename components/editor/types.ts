export type FocusRegion = {
  id: string;
  startTime: number;
  endTime: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export const FOCUS_ASPECT_RATIO = 16 / 9;
export const DEFAULT_REGION_DURATION = 2;
export const TRANSITION_GAP = 0.5;
export const MIN_REGION_DURATION = 0.3;
