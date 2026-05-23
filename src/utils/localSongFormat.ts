import type { SongType } from "@/types/main";

type LocalSongInput = Record<string, unknown>;

const DEFAULT_COVER = "/images/song.jpg?asset";

const toFiniteNumber = (value: unknown): number | undefined => {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
};

const getLocalId = (item: LocalSongInput): number | string => {
  const id = item.id;
  if (typeof id === "number" && Number.isFinite(id)) return id;
  if (typeof id === "string" && id.trim()) return id;
  const fallback = item.path || item.name || item.title;
  return typeof fallback === "string" && fallback.trim() ? fallback : 0;
};

const getPathName = (path: unknown): string => {
  if (typeof path !== "string") return "";
  return (
    path
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.[^.]+$/, "") || ""
  );
};

const getText = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
};

const getArtists = (item: LocalSongInput): SongType["artists"] => {
  const artist = item.artist ?? item.artists;
  if (typeof artist === "string") return artist;
  if (Array.isArray(artist)) {
    return artist
      .map((value) => {
        if (typeof value === "string") return value;
        if (value && typeof value === "object" && "name" in value) {
          return String(value.name || "");
        }
        return "";
      })
      .filter(Boolean)
      .join(" / ");
  }
  return "";
};

const getAlbum = (item: LocalSongInput): SongType["album"] => {
  const album = item.album;
  if (typeof album === "string") return album;
  if (album && typeof album === "object" && "name" in album) return String(album.name || "");
  return "";
};

export const normalizeLocalSongSize = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return 0;
  const size = Number(value);
  if (!Number.isFinite(size)) return 0;
  // 旧 JS 扫描器返回 MB 字符串，带小数时按 MB 兼容。
  return value.includes(".") ? size * 1024 * 1024 : size;
};

const getLocalQuality = (item: LocalSongInput): SongType["quality"] => {
  const rawQuality = item.quality;
  if (typeof rawQuality === "string" && rawQuality.trim()) {
    return rawQuality as SongType["quality"];
  }
  const bitrate = toFiniteNumber(rawQuality) ?? toFiniteNumber(item.bitrate);
  if (!bitrate) return undefined;
  if (bitrate >= 960000) return "Hi-Res" as SongType["quality"];
  if (bitrate >= 441000) return "SQ" as SongType["quality"];
  if (bitrate >= 320000) return "HQ" as SongType["quality"];
  if (bitrate >= 160000) return "MQ" as SongType["quality"];
  return "LQ" as SongType["quality"];
};

export const formatLocalSongsList = (data: unknown[]): SongType[] => {
  if (!data) return [];
  const list = Array.isArray(data) ? data : [data];
  return list.filter(Boolean).map((rawItem) => {
    const item = rawItem as LocalSongInput;
    const path = typeof item.path === "string" ? item.path : undefined;
    const trackNumber = toFiniteNumber(item.trackNumber ?? item.track_number);
    return {
      id: getLocalId(item) as SongType["id"],
      name: getText(item.name, item.title, getPathName(path)),
      artists: getArtists(item),
      album: getAlbum(item),
      cover: getText(item.cover) || DEFAULT_COVER,
      duration: toFiniteNumber(item.duration) ?? 0,
      free: 0,
      mv: null,
      size: normalizeLocalSongSize(item.size),
      path,
      pc: !!item.pc,
      quality: getLocalQuality(item),
      createTime: toFiniteNumber(item.createTime),
      updateTime: toFiniteNumber(item.updateTime),
      trackNumber,
      replayGain: item.replayGain as SongType["replayGain"],
      type: "song",
    };
  });
};
