import assert from "node:assert/strict";
import test from "node:test";
import { formatLocalSongsList } from "./localSongFormat";

test("本地歌曲保留字符串 ID 并补齐稳定字段", () => {
  const songs = formatLocalSongsList([
    {
      id: "8d4c2f1a9b0e7c6d",
      path: "D:/Music/song.flac",
      title: "本地歌曲",
      artist: "歌手",
      album: "专辑",
      duration: 180000,
      cover: "file:///D:/cache/covers/8d4c2f1a9b0e7c6d.jpg",
      size: 52_428_800,
      quality: 960000,
    },
  ]);

  assert.equal(songs[0].id, "8d4c2f1a9b0e7c6d");
  assert.equal(songs[0].name, "本地歌曲");
  assert.equal(songs[0].artists, "歌手");
  assert.equal(songs[0].album, "专辑");
  assert.equal(songs[0].cover, "file:///D:/cache/covers/8d4c2f1a9b0e7c6d.jpg");
  assert.equal(songs[0].free, 0);
  assert.equal(songs[0].mv, null);
  assert.equal(songs[0].size, 52_428_800);
  assert.equal(songs[0].quality, "Hi-Res");
  assert.equal(songs[0].type, "song");
});

test("本地歌曲兼容旧扫描的 MB 字符串大小和 camelCase 曲目序号", () => {
  const songs = formatLocalSongsList([
    {
      id: "legacy-id",
      path: "D:/Music/legacy.mp3",
      name: "旧扫描歌曲",
      artists: "旧歌手",
      album: "旧专辑",
      duration: 90000,
      size: "3.50",
      bitrate: 320000,
      trackNumber: 7,
    },
  ]);

  assert.equal(songs[0].size, 3.5 * 1024 * 1024);
  assert.equal(songs[0].quality, "HQ");
  assert.equal(songs[0].trackNumber, 7);
  assert.equal(songs[0].cover, "/images/song.jpg?asset");
});
