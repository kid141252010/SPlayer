import assert from "node:assert/strict";
import test from "node:test";
import type { SongType } from "../types/main";
import {
  extractVoiceListPrograms,
  getPlayableAudioId,
  isMixPodcastPlaylist,
  isPodcastTrackItem,
  resolveVoiceListIdFromSearch,
  resolvePodcastTrackIds,
  shouldFallbackToPlaylistTrackAll,
  splitPlaylistTracksByType,
} from "./playlistTrack";

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

test("混合播客歌单即使普通曲目数为 0 也识别为播客歌单", () => {
  assert.equal(isMixPodcastPlaylist({ mixPodcastPlaylist: true, trackCount: 0 }), true);
  assert.equal(isMixPodcastPlaylist({ mixPodcastPlaylist: false, trackCount: 0 }), false);
});

test("从 voicelist 常见返回结构中抽取节目列表", () => {
  const fromVoices = extractVoiceListPrograms({
    data: {
      voices: [{ id: 1 }, { voice: { id: 2 } }],
    },
  });
  const fromList = extractVoiceListPrograms({
    data: {
      list: [{ program: { id: 3 } }],
    },
  });

  assert.deepEqual(fromVoices, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(fromList, [{ id: 3 }]);
});

test("按歌单名和创建者从 voicelist 搜索结果解析真实播客列表 ID", () => {
  const result = resolveVoiceListIdFromSearch(
    {
      data: {
        resources: [
          {
            resourceId: "1211775933",
            baseInfo: {
              id: 1211775933,
              name: "全糖主义",
              dj: { userId: 12099350297 },
            },
          },
          {
            resourceId: "1491612062",
            baseInfo: {
              id: 1491612062,
              name: "愉悦主义",
              dj: { userId: 2120174821 },
            },
          },
        ],
      },
    },
    "愉悦主义",
    2120174821,
  );

  assert.equal(result, 1491612062);
});

test("从 voicelist/search 的 list 结构解析真实播客列表 ID", () => {
  const result = resolveVoiceListIdFromSearch(
    {
      data: {
        list: [
          {
            voiceListId: "1491612062",
            voiceListName: "愉悦主义",
            userId: 2120174821,
          },
        ],
      },
    },
    "愉悦主义",
    2120174821,
  );

  assert.equal(result, 1491612062);
});

test("voicelist/search 缺少创建者字段且名称唯一时允许解析", () => {
  const result = resolveVoiceListIdFromSearch(
    {
      data: {
        list: [
          {
            voiceListId: "1491612062",
            voiceListName: "愉悦主义",
          },
        ],
      },
    },
    "愉悦主义",
    2120174821,
  );

  assert.equal(result, 1491612062);
});

test("voicelist 搜索结果无法精确匹配时不返回错误 ID", () => {
  const result = resolveVoiceListIdFromSearch(
    {
      data: {
        resources: [
          {
            resourceId: "1491612062",
            baseInfo: {
              id: 1491612062,
              name: "愉悦主义",
              dj: { userId: 999 },
            },
          },
        ],
      },
    },
    "愉悦主义",
    2120174821,
  );

  assert.equal(result, null);
});

test("普通歌曲携带 songId 和 mainSong 字段时不识别为播客", () => {
  assert.equal(
    isPodcastTrackItem({
      id: 100,
      songId: 100,
      name: "普通歌曲",
      mainSong: {
        id: 100,
        name: "普通歌曲",
      },
      ar: [{ id: 1, name: "歌手" }],
      al: { id: 10, name: "专辑" },
    }),
    false,
  );
});

test("播客节目字段仍识别为播客", () => {
  assert.equal(
    isPodcastTrackItem({
      voiceId: 100,
      songId: 200,
      voiceName: "播客单集",
      voiceListId: 300,
      voiceListName: "播客列表",
    }),
    true,
  );
});

test("按歌曲类型拆分普通歌曲和播客节目 ID", () => {
  const result = splitPlaylistTracksByType([
    makeSong({ id: 1 }),
    makeSong({ id: 2, type: "radio", dj: { id: 200, name: "Radio" } }),
    makeSong({ id: 0 }),
  ]);

  assert.deepEqual(result, { songIds: [1], radioIds: [2] });
});

test("普通歌曲使用歌曲 ID 作为可播放音频 ID", () => {
  assert.equal(getPlayableAudioId(makeSong({ id: 100 })), 100);
});

test("播客单集优先使用主音频 ID 作为可播放音频 ID", () => {
  assert.equal(
    getPlayableAudioId(makeSong({ id: 100, type: "radio", dj: { id: 200, name: "Radio" } })),
    200,
  );
});

test("缺少主音频 ID 的播客单集回退到节目 ID", () => {
  assert.equal(getPlayableAudioId(makeSong({ id: 100, type: "radio" })), 100);
});

test("播客 raw 节目字段可解析出节目 ID 与可播放音频 ID", () => {
  const result = resolvePodcastTrackIds({
    voiceId: 100,
    songId: 200,
    voiceName: "播客单集",
    voiceListId: 300,
    voiceListName: "播客列表",
  });

  assert.deepEqual(result, { songId: 100, playableAudioId: 200, radioId: 300 });
});

test("播客 raw 节目字段中 mainTrackId 优先作为可播放音频 ID", () => {
  const result = resolvePodcastTrackIds({
    voiceId: 100,
    mainTrackId: 300,
    songId: 200,
    voiceName: "播客单集",
  });

  assert.deepEqual(result, { songId: 100, playableAudioId: 300, radioId: null });
});

test("播客 raw 节目字段中 audioId 可作为可播放音频 ID", () => {
  const result = resolvePodcastTrackIds({
    voiceId: 100,
    audioId: 400,
    voiceName: "播客单集",
  });

  assert.deepEqual(result, { songId: 100, playableAudioId: 400, radioId: null });
});
