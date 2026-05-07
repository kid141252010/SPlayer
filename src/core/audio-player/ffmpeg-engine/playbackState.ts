import type { PlayerState } from "./types";

interface FfmpegEndedState {
  state: PlayerState;
  activeSourceCount: number;
  isDecodingFinished: boolean;
  currentTime: number;
  duration: number;
  endTolerance?: number;
}

const DEFAULT_END_TOLERANCE = 0.35;

export const clampPlaybackTime = (currentTime: number, duration: number): number => {
  const safeTime = Number.isFinite(currentTime) ? currentTime : 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, safeTime);
  return Math.max(0, Math.min(safeTime, duration));
};

export const shouldDispatchFfmpegEnded = ({
  state,
  activeSourceCount,
  isDecodingFinished,
  currentTime,
  duration,
  endTolerance = DEFAULT_END_TOLERANCE,
}: FfmpegEndedState): boolean => {
  if (state !== "playing") return false;
  if (activeSourceCount > 0) return false;
  if (!isDecodingFinished) return false;
  if (!Number.isFinite(duration) || duration <= 0) return true;

  const safeTolerance = Math.max(0, endTolerance);
  return currentTime >= duration - safeTolerance;
};
