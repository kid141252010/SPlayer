import type { SongType } from "../types/main";

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
