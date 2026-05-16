export type LyricMatchLevel = "strict" | "normal" | "loose";

export type LyricMatchConfidence = "none" | "low" | "medium" | "high";

export type LyricMatchSource = "id" | "metadata";

export interface LyricMatchCandidate {
  ncmIds: number[];
  musicNames: string[];
  artists: string[];
  filePath?: string;
}

export interface LyricMatchQuery {
  songName: string;
  artists?: string[];
  matchLevel: LyricMatchLevel;
}

export interface LyricCandidateMatchResult {
  matched: boolean;
  confidence: LyricMatchConfidence;
  score: number;
  nameScore: number;
  artistScore: number;
  reason?: string;
}

export interface SelectedLyricCandidate {
  candidate: LyricMatchCandidate;
  match: LyricCandidateMatchResult;
  source: LyricMatchSource;
}

const VERSION_MARKERS: Array<[string, RegExp]> = [
  ["live", /\b(?:live|concert)\b|现场|演唱会|演出版/iu],
  ["remix", /\bremix(?:ed)?\b|混音|重混/iu],
  ["acoustic", /\bacoustic\b|不插电|原声版/iu],
  ["instrumental", /\binstrumental\b|\boff\s*vocal\b|\bkaraoke\b|伴奏|纯音乐/iu],
  ["demo", /\bdemo\b|试听版/iu],
  ["cover", /\bcover\b|翻唱/iu],
  ["remaster", /\bremaster(?:ed)?\b|重制/iu],
  ["piano", /\bpiano\b|钢琴版/iu],
];

export const normalizeLyricMatchText = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();

const normalizeList = (values?: string[]): string[] =>
  (values || []).map(normalizeLyricMatchText).filter(Boolean);

const exactTextMatch = (a: string, b: string): boolean =>
  normalizeLyricMatchText(a) === normalizeLyricMatchText(b);

const versionMarkerSet = (value: string): Set<string> => {
  const text = normalizeLyricMatchText(value);
  const result = new Set<string>();
  for (const [key, pattern] of VERSION_MARKERS) {
    if (pattern.test(text)) result.add(key);
  }
  return result;
};

const hasVersionMarkerConflict = (a: string, b: string): boolean => {
  const aMarkers = versionMarkerSet(a);
  const bMarkers = versionMarkerSet(b);
  for (const marker of aMarkers) {
    if (!bMarkers.has(marker)) return true;
  }
  for (const marker of bMarkers) {
    if (!aMarkers.has(marker)) return true;
  }
  return false;
};

const isAsciiWordChar = (value: string): boolean => /^[a-z0-9]$/iu.test(value);

const containsWithSafeBoundary = (longer: string, shorter: string): boolean => {
  if (shorter.length < 3) return false;
  let index = longer.indexOf(shorter);
  while (index >= 0) {
    const before = index > 0 ? longer[index - 1] : "";
    const after = index + shorter.length < longer.length ? longer[index + shorter.length] : "";
    if ((!before || !isAsciiWordChar(before)) && (!after || !isAsciiWordChar(after))) {
      return true;
    }
    index = longer.indexOf(shorter, index + 1);
  }
  return false;
};

const containsTitleMatch = (a: string, b: string): boolean => {
  const left = normalizeLyricMatchText(a);
  const right = normalizeLyricMatchText(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (hasVersionMarkerConflict(left, right)) return false;

  const [shorter, longer] =
    left.length <= right.length ? [left, right] : [right, left];
  if (shorter.length / longer.length < 0.5) return false;
  return containsWithSafeBoundary(longer, shorter);
};

const bestNameScore = (songName: string, candidateNames: string[], level: LyricMatchLevel) => {
  const targetName = normalizeLyricMatchText(songName);
  if (!targetName) return 0;
  for (const name of candidateNames) {
    if (exactTextMatch(targetName, name)) return 100;
  }
  if (level !== "loose") return 0;
  for (const name of candidateNames) {
    if (containsTitleMatch(targetName, name)) return 72;
  }
  return 0;
};

const bestArtistScore = (
  queryArtists: string[],
  candidateArtists: string[],
  level: LyricMatchLevel,
) => {
  if (!queryArtists.length || !candidateArtists.length) return 80;
  for (const queryArtist of queryArtists) {
    for (const candidateArtist of candidateArtists) {
      if (exactTextMatch(queryArtist, candidateArtist)) return 100;
    }
  }
  if (level !== "loose") return 0;
  for (const queryArtist of queryArtists) {
    for (const candidateArtist of candidateArtists) {
      if (containsTitleMatch(queryArtist, candidateArtist)) return 68;
    }
  }
  return 0;
};

const confidenceFromScore = (
  score: number,
  nameScore: number,
  artistScore: number,
): LyricMatchConfidence => {
  if (nameScore === 100 && artistScore >= 80) return "high";
  if (score >= 70) return "medium";
  if (score > 0) return "low";
  return "none";
};

export const matchLyricCandidate = (
  query: LyricMatchQuery,
  candidate: LyricMatchCandidate,
): LyricCandidateMatchResult => {
  const queryArtists = normalizeList(query.artists);
  const candidateNames = normalizeList(candidate.musicNames);
  const candidateArtists = normalizeList(candidate.artists);
  const nameScore = bestNameScore(query.songName, candidateNames, query.matchLevel);
  const artistScore = bestArtistScore(queryArtists, candidateArtists, query.matchLevel);
  const score = Math.round(nameScore * 0.7 + artistScore * 0.3);
  const confidence = confidenceFromScore(score, nameScore, artistScore);

  if (!nameScore) {
    return {
      matched: false,
      confidence: "none",
      score: 0,
      nameScore,
      artistScore,
      reason: "name-mismatch",
    };
  }

  if (query.matchLevel === "strict" && queryArtists.length > 0 && artistScore !== 100) {
    return {
      matched: false,
      confidence: "none",
      score: 0,
      nameScore,
      artistScore,
      reason: "artist-mismatch",
    };
  }

  if (query.matchLevel === "normal" && queryArtists.length > 0 && candidateArtists.length > 0) {
    if (artistScore !== 100) {
      return {
        matched: false,
        confidence: "none",
        score: 0,
        nameScore,
        artistScore,
        reason: "artist-mismatch",
      };
    }
  }

  if (query.matchLevel === "normal" && nameScore !== 100) {
    return {
      matched: false,
      confidence: "none",
      score: 0,
      nameScore,
      artistScore,
      reason: "name-mismatch",
    };
  }

  if (confidence === "low" || confidence === "none") {
    return {
      matched: false,
      confidence,
      score,
      nameScore,
      artistScore,
      reason: "low-confidence",
    };
  }

  return {
    matched: true,
    confidence,
    score,
    nameScore,
    artistScore,
  };
};

export const selectBestLyricCandidate = (options: {
  ncmId?: number;
  songName?: string;
  artists?: string[];
  matchLevel: LyricMatchLevel;
  candidates: LyricMatchCandidate[];
}): SelectedLyricCandidate | undefined => {
  if (typeof options.ncmId === "number" && options.ncmId > 0) {
    const candidate = options.candidates.find((item) => item.ncmIds.includes(options.ncmId!));
    if (candidate) {
      return {
        candidate,
        source: "id",
        match: {
          matched: true,
          confidence: "high",
          score: 100,
          nameScore: 100,
          artistScore: 100,
        },
      };
    }
  }

  if (!options.songName) return undefined;

  const matches = options.candidates
    .map((candidate, index) => ({
      candidate,
      index,
      match: matchLyricCandidate(
        {
          songName: options.songName!,
          artists: options.artists,
          matchLevel: options.matchLevel,
        },
        candidate,
      ),
    }))
    .filter((item) => item.match.matched)
    .sort((a, b) => b.match.score - a.match.score || a.index - b.index);

  const best = matches[0];
  if (!best) return undefined;
  return {
    candidate: best.candidate,
    match: best.match,
    source: "metadata",
  };
};
