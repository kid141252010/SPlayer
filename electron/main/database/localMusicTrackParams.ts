type TrackInput = Record<string, unknown>;

export const buildTrackParams = (track: TrackInput, columns: string[]): Record<string, unknown> => {
  const params: Record<string, unknown> = {};
  for (const col of columns) {
    if (col === "track_number") {
      params[col] = track.track_number ?? track.trackNumber ?? null;
    } else {
      params[col] = track[col] ?? null;
    }
  }
  return params;
};
