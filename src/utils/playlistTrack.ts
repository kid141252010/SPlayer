import type { SongType } from "../types/main";

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => {
  return !!value && typeof value === "object";
};

const isValidTrackId = (id: unknown): id is number => {
  return typeof id === "number" && Number.isFinite(id) && id > 0;
};

const toValidTrackId = (id: unknown): number | null => {
  const numberId = typeof id === "string" ? Number(id) : id;
  return isValidTrackId(numberId) ? numberId : null;
};

/**
 * 判断歌单快路径结果是否可信
 */
export const shouldFallbackToPlaylistTrackAll = (
  expectedIds: Array<number | null | undefined>,
  songs: SongType[],
): boolean => {
  if (!Array.isArray(expectedIds) || expectedIds.length === 0) return true;
  if (!Array.isArray(songs) || songs.length === 0) return true;
  if (songs.length !== expectedIds.length) return true;

  const expectedCount = new Map<number, number>();
  for (const id of expectedIds) {
    if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) return true;
    expectedCount.set(id, (expectedCount.get(id) ?? 0) + 1);
  }

  const resultCount = new Map<number, number>();
  for (const song of songs) {
    if (!song || song.type === "radio") return true;
    if (typeof song.id !== "number" || !Number.isFinite(song.id) || song.id <= 0) return true;
    resultCount.set(song.id, (resultCount.get(song.id) ?? 0) + 1);
  }

  if (resultCount.size !== expectedCount.size) return true;

  for (const [id, count] of expectedCount) {
    if (resultCount.get(id) !== count) return true;
  }

  return false;
};

/**
 * 判断是否为播客混合歌单
 */
export const isMixPodcastPlaylist = (playlist: unknown): boolean => {
  return isRecord(playlist) && playlist.mixPodcastPlaylist === true;
};

/**
 * 判断原始曲目是否为播客节目
 */
export const isPodcastTrackItem = (item: unknown): boolean => {
  if (!isRecord(item)) return false;

  const program = item.program ?? item.programInfo ?? item.voice ?? item.voiceInfo;
  const radio = item.radio ?? item.djRadio ?? item.voiceList ?? item.radioInfo;
  return !!(
    isRecord(program) ||
    isRecord(radio) ||
    toValidTrackId(item.programId) ||
    toValidTrackId(item.voiceId) ||
    toValidTrackId(item.voiceListId) ||
    toValidTrackId(item.radioId) ||
    toValidTrackId(item.djRadioId) ||
    typeof item.voiceName === "string" ||
    typeof item.voiceListName === "string" ||
    typeof item.radioName === "string"
  );
};

/**
 * 抽取播客歌单节目列表
 */
export const extractVoiceListPrograms = (payload: unknown): unknown[] => {
  if (!isRecord(payload)) return [];

  const data = isRecord(payload.data) ? payload.data : undefined;
  const result = isRecord(payload.result) ? payload.result : undefined;
  const candidates = [
    payload.programs,
    payload.voices,
    payload.list,
    payload.records,
    payload.items,
    data?.programs,
    data?.voices,
    data?.list,
    data?.records,
    data?.items,
    result?.programs,
    result?.voices,
    result?.list,
    result?.records,
    result?.items,
  ];

  const list = candidates.find(Array.isArray);
  if (!list) return [];

  return list
    .map((item) => {
      if (!isRecord(item)) return item;
      return item.program ?? item.voice ?? item.resource ?? item.data ?? item;
    })
    .filter(Boolean);
};

/**
 * 从搜索结果解析真实播客列表 ID
 */
export const resolveVoiceListIdFromSearch = (
  payload: unknown,
  name: string,
  creatorUserId?: number,
): number | null => {
  if (!isRecord(payload)) return null;

  const data = isRecord(payload.data) ? payload.data : undefined;
  const result = isRecord(payload.result) ? payload.result : undefined;
  const candidates = [
    payload.resources,
    payload.list,
    data?.resources,
    data?.list,
    data?.voicelists,
    result?.resources,
    result?.list,
    result?.voicelists,
  ];
  const resources = candidates.find(Array.isArray);
  if (!resources) return null;

  const trimmedName = name.trim();
  const getVoiceListName = (item: unknown) => {
    if (!isRecord(item)) return false;
    const baseInfo = isRecord(item.baseInfo) ? item.baseInfo : item;
    return String(
      baseInfo.name ??
        baseInfo.voiceListName ??
        item.name ??
        item.voiceListName ??
        item.podcastName ??
        "",
    ).trim();
  };
  const getCreatorUserId = (item: unknown) => {
    if (!isRecord(item)) return null;
    const baseInfo = isRecord(item.baseInfo) ? item.baseInfo : item;
    const dj = isRecord(baseInfo.dj) ? baseInfo.dj : undefined;
    const creator = isRecord(baseInfo.creator) ? baseInfo.creator : undefined;
    const itemDj = isRecord(item.dj) ? item.dj : undefined;
    const itemCreator = isRecord(item.creator) ? item.creator : undefined;
    return toValidTrackId(
      dj?.userId ??
        creator?.userId ??
        baseInfo.userId ??
        itemDj?.userId ??
        itemCreator?.userId ??
        item.userId,
    );
  };
  const exactNameMatches = resources.filter((item) => {
    const voiceName = getVoiceListName(item);
    if (voiceName !== trimmedName) return false;
    return true;
  });
  const matched =
    exactNameMatches.find((item) => {
      if (!creatorUserId) return true;
      return getCreatorUserId(item) === creatorUserId;
    }) ??
    (exactNameMatches.length === 1 && exactNameMatches.every((item) => !getCreatorUserId(item))
      ? exactNameMatches[0]
      : undefined);

  if (!isRecord(matched)) return null;
  const baseInfo = isRecord(matched.baseInfo) ? matched.baseInfo : matched;
  return toValidTrackId(
    baseInfo.id ?? baseInfo.voiceListId ?? matched.voiceListId ?? matched.resourceId ?? matched.id,
  );
};

/**
 * 按类型拆分歌单曲目 ID
 */
export const splitPlaylistTracksByType = (
  songs: SongType[],
): { songIds: number[]; radioIds: number[] } => {
  return (Array.isArray(songs) ? songs : []).reduce(
    (result, song) => {
      if (!isValidTrackId(song?.id)) return result;
      if (song.type === "radio") {
        result.radioIds.push(song.id);
      } else {
        result.songIds.push(song.id);
      }
      return result;
    },
    { songIds: [] as number[], radioIds: [] as number[] },
  );
};

/**
 * 获取实际用于播放和音乐缓存的音频 ID
 */
export const getPlayableAudioId = (song: Pick<SongType, "id" | "type" | "dj">): number | null => {
  if (song?.type === "radio") {
    return toValidTrackId(song.dj?.id) ?? toValidTrackId(song.id);
  }
  return toValidTrackId(song?.id);
};

/**
 * 解析播客节目的节目 ID 和可播放音频 ID
 */
export const resolvePodcastTrackIds = (
  item: unknown,
): { songId: number | null; playableAudioId: number | null; radioId: number | null } => {
  if (!isRecord(item)) {
    return { songId: null, playableAudioId: null, radioId: null };
  }

  const program = isRecord(item.program)
    ? item.program
    : isRecord(item.programInfo)
      ? item.programInfo
      : isRecord(item.voice)
        ? item.voice
        : isRecord(item.voiceInfo)
          ? item.voiceInfo
          : undefined;
  const radio = isRecord(item.radio)
    ? item.radio
    : isRecord(item.djRadio)
      ? item.djRadio
      : isRecord(item.voiceList)
        ? item.voiceList
        : isRecord(item.radioInfo)
          ? item.radioInfo
          : program;
  const mainSong = isRecord(item.mainSong)
    ? item.mainSong
    : isRecord(item.mainTrack)
      ? item.mainTrack
      : isRecord(program?.mainSong)
        ? program.mainSong
        : isRecord(program?.mainTrack)
          ? program.mainTrack
          : undefined;

  const songId = toValidTrackId(
    item.programId ?? item.voiceId ?? program?.id ?? program?.voiceId ?? item.id,
  );
  const playableAudioId = toValidTrackId(
    item.mainTrackId ??
      item.mainSongId ??
      mainSong?.id ??
      program?.mainTrackId ??
      program?.mainSongId ??
      program?.songId ??
      program?.audioId ??
      program?.trackId ??
      item.audioId ??
      item.trackId ??
      item.songId ??
      songId,
  );
  const radioId = toValidTrackId(
    radio?.id ?? item.radioId ?? item.djRadioId ?? item.voiceListId ?? program?.radioId,
  );

  return { songId, playableAudioId, radioId };
};
