import assert from "node:assert/strict";
import test from "node:test";
import { shouldFetchLocalMetadata } from "./localPlaybackInfo";

test("本地歌曲已有扫描音质时播放阶段不再解析元数据", () => {
  assert.equal(shouldFetchLocalMetadata({ quality: "SQ" as never }), false);
});

test("本地歌曲缺少扫描音质时播放阶段回退解析元数据", () => {
  assert.equal(shouldFetchLocalMetadata({}), true);
});
