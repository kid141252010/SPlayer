import assert from "node:assert/strict";
import test from "node:test";
import {
  matchLyricCandidate,
  selectBestLyricCandidate,
  type LyricMatchCandidate,
} from "./lyric-match";

const candidate = (
  overrides: Partial<LyricMatchCandidate> = {},
): LyricMatchCandidate => ({
  ncmIds: [],
  musicNames: [],
  artists: [],
  ...overrides,
});

test("宽松匹配拒绝单侧 live 后缀", () => {
  const result = matchLyricCandidate(
    { songName: "Song", artists: ["Artist"], matchLevel: "loose" },
    candidate({ musicNames: ["Song Live"], artists: ["Artist"] }),
  );

  assert.equal(result.matched, false);
});

test("查询 ID 命中时优先于更早出现的歌名候选", () => {
  const live = candidate({
    ncmIds: [222],
    musicNames: ["Song Live"],
    artists: ["Artist"],
    filePath: "a-live.ttml",
  });
  const exact = candidate({
    ncmIds: [111],
    musicNames: ["Song"],
    artists: ["Artist"],
    filePath: "z-exact.ttml",
  });

  const result = selectBestLyricCandidate({
    ncmId: 111,
    songName: "Song",
    artists: ["Artist"],
    matchLevel: "loose",
    candidates: [live, exact],
  });

  assert.equal(result?.candidate.filePath, "z-exact.ttml");
  assert.equal(result?.source, "id");
});

test("严格模式要求歌名精确且歌手精确", () => {
  const result = matchLyricCandidate(
    { songName: "Song", artists: ["Artist"], matchLevel: "strict" },
    candidate({ musicNames: ["Song"], artists: ["Other Artist"] }),
  );

  assert.equal(result.matched, false);
});

test("严格模式在本地歌手缺失时允许歌名精确命中", () => {
  const result = matchLyricCandidate(
    { songName: "Song", matchLevel: "strict" },
    candidate({ musicNames: ["Song"], artists: ["Artist"] }),
  );

  assert.equal(result.matched, true);
  assert.equal(result.confidence, "high");
});

test("标准模式允许候选缺少歌手但不允许歌名包含", () => {
  const exactWithoutArtist = matchLyricCandidate(
    { songName: "Song", artists: ["Artist"], matchLevel: "normal" },
    candidate({ musicNames: ["Song"], artists: [] }),
  );
  const containsWithArtist = matchLyricCandidate(
    { songName: "Song", artists: ["Artist"], matchLevel: "normal" },
    candidate({ musicNames: ["Song Acoustic"], artists: ["Artist"] }),
  );

  assert.equal(exactWithoutArtist.matched, true);
  assert.equal(containsWithArtist.matched, false);
});

test("宽松模式允许无版本冲突的包含匹配", () => {
  const result = matchLyricCandidate(
    { songName: "Song", artists: ["Artist"], matchLevel: "loose" },
    candidate({ musicNames: ["The Song"], artists: ["Artist"] }),
  );

  assert.equal(result.matched, true);
  assert.equal(result.confidence, "medium");
});
