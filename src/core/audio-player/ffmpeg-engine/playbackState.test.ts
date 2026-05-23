import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldAcceptFfmpegChunk,
  shouldDispatchFfmpegEnded,
  shouldResumeFfmpegWorker,
} from "./playbackState";

test("暂停或挂起时不接收新的 FFmpeg chunk 排程", () => {
  assert.equal(shouldAcceptFfmpegChunk({ isPendingSeek: false, audioContextState: "running" }), true);
  assert.equal(shouldAcceptFfmpegChunk({ isPendingSeek: true, audioContextState: "running" }), false);
  assert.equal(
    shouldAcceptFfmpegChunk({
      isPendingSeek: false,
      audioContextState: "running",
      playerState: "paused",
    }),
    false,
  );
  assert.equal(
    shouldAcceptFfmpegChunk({ isPendingSeek: false, audioContextState: "suspended" }),
    false,
  );
});

test("ended 已派发后不再重复派发", () => {
  assert.equal(
    shouldDispatchFfmpegEnded({
      state: "playing",
      activeSourceCount: 0,
      isDecodingFinished: true,
      currentTime: 10,
      duration: 10,
      endedDispatched: true,
    }),
    false,
  );
});

test("只有播放中且 Worker 暂停时才恢复解码", () => {
  assert.equal(shouldResumeFfmpegWorker({ playerState: "playing", isWorkerPaused: true }), true);
  assert.equal(shouldResumeFfmpegWorker({ playerState: "paused", isWorkerPaused: true }), false);
  assert.equal(shouldResumeFfmpegWorker({ playerState: "playing", isWorkerPaused: false }), false);
});
