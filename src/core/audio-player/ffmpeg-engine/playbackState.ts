import type { PlayerState } from "./types";

interface FfmpegEndedState {
  state: PlayerState;
  activeSourceCount: number;
  isDecodingFinished: boolean;
  currentTime: number;
  duration: number;
  endedDispatched?: boolean;
  endTolerance?: number;
}

const DEFAULT_END_TOLERANCE = 0.35;
const DEFAULT_CHUNK_TIME_TOLERANCE = 0.75;

interface FfmpegChunkTimingInput {
  chunkStartTime: number;
  expectedStartTime: number;
  allowAnchor: boolean;
  tolerance?: number;
}

interface FfmpegChunkTimingResult {
  sourceStartTime: number;
  shouldSyncAnchor: boolean;
  usedFallback: boolean;
}

export const clampPlaybackTime = (currentTime: number, duration: number): number => {
  const safeTime = Number.isFinite(currentTime) ? currentTime : 0;
  if (!Number.isFinite(duration) || duration <= 0) return Math.max(0, safeTime);
  return Math.max(0, Math.min(safeTime, duration));
};

export const resolveFfmpegChunkTiming = ({
  chunkStartTime,
  expectedStartTime,
  allowAnchor,
  tolerance = DEFAULT_CHUNK_TIME_TOLERANCE,
}: FfmpegChunkTimingInput): FfmpegChunkTimingResult => {
  const fallbackStartTime = Math.max(0, Number.isFinite(expectedStartTime) ? expectedStartTime : 0);
  const safeTolerance = Math.max(0, tolerance);
  const hasValidChunkTime = Number.isFinite(chunkStartTime) && chunkStartTime >= 0;

  if (!hasValidChunkTime) {
    return {
      sourceStartTime: fallbackStartTime,
      shouldSyncAnchor: allowAnchor,
      usedFallback: true,
    };
  }

  if (allowAnchor) {
    return {
      sourceStartTime: chunkStartTime,
      shouldSyncAnchor: true,
      usedFallback: false,
    };
  }

  if (Math.abs(chunkStartTime - fallbackStartTime) > safeTolerance) {
    return {
      sourceStartTime: fallbackStartTime,
      shouldSyncAnchor: false,
      usedFallback: true,
    };
  }

  return {
    sourceStartTime: chunkStartTime,
    shouldSyncAnchor: false,
    usedFallback: false,
  };
};

export const shouldAcceptFfmpegChunk = ({
  isPendingSeek,
  audioContextState,
  playerState,
}: {
  isPendingSeek: boolean;
  audioContextState?: AudioContextState;
  playerState?: PlayerState;
}): boolean => {
  if (isPendingSeek) return false;
  if (playerState && playerState !== "playing") return false;
  return audioContextState !== "suspended" && audioContextState !== "closed";
};

export const shouldResumeFfmpegWorker = ({
  playerState,
  isWorkerPaused,
}: {
  playerState: PlayerState;
  isWorkerPaused: boolean;
}): boolean => playerState === "playing" && isWorkerPaused;

export const shouldDispatchFfmpegEnded = ({
  state,
  activeSourceCount,
  isDecodingFinished,
  currentTime,
  duration,
  endedDispatched = false,
  endTolerance = DEFAULT_END_TOLERANCE,
}: FfmpegEndedState): boolean => {
  if (endedDispatched) return false;
  if (state !== "playing") return false;
  if (activeSourceCount > 0) return false;
  if (!isDecodingFinished) return false;
  if (!Number.isFinite(duration) || duration <= 0) return true;

  const safeTolerance = Math.max(0, endTolerance);
  return currentTime >= duration - safeTolerance;
};
