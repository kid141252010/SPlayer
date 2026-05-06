import { QualityType } from "../src/types/main";
import {
  resolveTtmlSpatialOffset,
  type AudioChannelInfo,
} from "../src/utils/lyric/parseTTML";

const spatialTtml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <head>
    <metadata>
      <audio role="spatial" lyricOffset="0.42" />
    </metadata>
  </head>
  <body><div><p begin="00:00.000" end="00:01.000">A</p></div></body>
</tt>`;

const normalTtml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <head><metadata><audio role="stereo" lyricOffset="0.42" /></metadata></head>
  <body><div><p begin="00:00.000" end="00:01.000">A</p></div></body>
</tt>`;

const invalidOffsetTtml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml">
  <head><metadata><audio role="spatial" lyricOffset="abc" /></metadata></head>
  <body><div><p begin="00:00.000" end="00:01.000">A</p></div></body>
</tt>`;

const reliableChannels = (channels: number): AudioChannelInfo => ({
  channels,
  source: "ffmpeg",
  reliable: true,
});

const assertEqual = <T>(name: string, actual: T, expected: T) => {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${String(expected)}, got ${String(actual)}`);
  }
};

const stereo = resolveTtmlSpatialOffset({
  ttml: spatialTtml,
  channelInfo: reliableChannels(2),
  songQuality: QualityType.Dolby,
  audioSource: "official",
});
assertEqual("2声道不应用", stereo.shouldApply, false);
assertEqual("2声道 offset 为0", stereo.offsetMs, 0);

const surround = resolveTtmlSpatialOffset({
  ttml: spatialTtml,
  channelInfo: reliableChannels(6),
  songQuality: QualityType.Dolby,
  audioSource: "official",
});
assertEqual("6声道应用", surround.shouldApply, true);
assertEqual("6声道 offset", surround.offsetMs, 420);

const noSpatial = resolveTtmlSpatialOffset({
  ttml: normalTtml,
  channelInfo: reliableChannels(6),
});
assertEqual("无 spatial 不应用", noSpatial.shouldApply, false);

const invalid = resolveTtmlSpatialOffset({
  ttml: invalidOffsetTtml,
  channelInfo: reliableChannels(6),
});
assertEqual("无效 offset 不应用", invalid.shouldApply, false);

const unknown = resolveTtmlSpatialOffset({
  ttml: spatialTtml,
  channelInfo: undefined,
});
assertEqual("未知声道不应用", unknown.shouldApply, false);

console.log("TTML offset tests passed");
