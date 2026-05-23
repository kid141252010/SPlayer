import assert from "node:assert/strict";
import test from "node:test";
import { buildTrackParams } from "./localMusicTrackParams";

test("原生扫描的 trackNumber 写入 track_number 参数", () => {
  const params = buildTrackParams(
    {
      id: "track-id",
      trackNumber: 8,
    },
    ["id", "track_number"],
  );

  assert.deepEqual(params, {
    id: "track-id",
    track_number: 8,
  });
});
