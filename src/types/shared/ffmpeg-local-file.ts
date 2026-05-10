export const FFMPEG_LOCAL_FILE_IPC = {
  STAT: "ffmpeg-local-file-stat",
  READ: "ffmpeg-local-file-read",
} as const;

export type FfmpegLocalFileStatResult =
  | {
      ok: true;
      size: number;
      name: string;
    }
  | {
      ok: false;
      error: string;
    };

export type FfmpegLocalFileReadResult =
  | {
      ok: true;
      data: ArrayBuffer;
      bytesRead: number;
    }
  | {
      ok: false;
      error: string;
    };
