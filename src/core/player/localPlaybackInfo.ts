import type { SongType } from "@/types/main";

export const shouldFetchLocalMetadata = (song: Pick<SongType, "quality">): boolean => !song.quality;
