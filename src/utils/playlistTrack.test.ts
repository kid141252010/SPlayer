import assert from "node:assert/strict";
import test from "node:test";
import type { SongType } from "../types/main";
import { shouldFallbackToPlaylistTrackAll } from "./playlistTrack";

const makeSong = (overrides: Partial<SongType> = {}): SongType =>
  ({
    id: 1,
    name: "Song",
    artists: "Artist",
    album: "Album",
    cover: "/images/song.jpg?asset",
    duration: 180000,
    free: 0,
    mv: null,
    type: "song",
    ...overrides,
  }) as SongType;

test("普通歌曲完整命中时可使用快路径", () => {
  const result = shouldFallbackToPlaylistTrackAll(
    [1, 2],
    [makeSong({ id: 1 }), makeSong({ id: 2 })],
  );

  assert.equal(result, false);
});

test("结果缺项时回退到全量拉取", () => {
  const result = shouldFallbackToPlaylistTrackAll([1, 2], [makeSong({ id: 1 })]);

  assert.equal(result, true);
});

test("结果重复时回退到全量拉取", () => {
  const result = shouldFallbackToPlaylistTrackAll(
    [1, 2],
    [makeSong({ id: 1 }), makeSong({ id: 1 })],
  );

  assert.equal(result, true);
});

test("结果包含电台节目时回退到全量拉取", () => {
  const result = shouldFallbackToPlaylistTrackAll(
    [1, 2],
    [makeSong({ id: 1 }), makeSong({ id: 2, type: "radio", dj: { id: 2, name: "DJ" } })],
  );

  assert.equal(result, true);
});
