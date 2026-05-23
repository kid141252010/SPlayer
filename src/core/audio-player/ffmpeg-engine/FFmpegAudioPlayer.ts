import { toError } from "@/utils/error";
import {
  FFMPEG_LOCAL_FILE_IPC,
  type FfmpegLocalFileReadResult,
  type FfmpegLocalFileStatResult,
} from "@/types/shared";
import { type GetDetail } from "@/utils/TypedEventTarget";
import { AudioErrorCode, BaseAudioPlayer, type AudioEventMap } from "../BaseAudioPlayer";
import type { AudioChannelInfo, EngineCapabilities } from "../IPlaybackEngine";
import FFmpegWorker from "./ffmpeg.worker?worker";
import {
  clampPlaybackTime,
  resolveFfmpegChunkTiming,
  shouldAcceptFfmpegChunk,
  shouldDispatchFfmpegEnded,
  shouldResumeFfmpegWorker,
} from "./playbackState";
import { SharedRingBuffer } from "./SharedRingBuffer";
import type { AudioMetadata, PlayerState, WorkerRequest, WorkerResponse } from "./types";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const HIGH_WATER_MARK = 30;
const LOW_WATER_MARK = 10;
const IDX_SEEK_GEN = 4;
const FFMPEG_INIT_TIMEOUT = 30000;
const FFMPEG_SEEK_TIMEOUT = 30000;
const LOCAL_FILE_READ_CHUNK_SIZE = 512 * 1024;
const SEEK_SUPERSEDED_ERROR = "Superseded by new seek";

/**
 * 基于 FFmpeg WASM 的音频播放器实现
 *
 * 使用 Web Worker 在后台进行音频解码，支持更多音频格式（如 FLAC、ALAC 等）。
 * 解码后的 PCM 数据通过 AudioBufferSourceNode 播放。
 */
export class FFmpegAudioPlayer extends BaseAudioPlayer {
  /** 解码 Worker 实例 */
  private worker: Worker | null = null;
  /** 音频元数据 */
  private metadata: AudioMetadata | null = null;
  /** 当前元数据封面 Blob URL */
  private metadataCoverUrl: string | null = null;

  /** 当前播放器状态 */
  private playerState: PlayerState = "idle";
  /** 下一个 AudioBufferSourceNode 的开始时间 */
  private nextStartTime = 0;
  /** Worker 是否暂停（用于缓冲区管理） */
  private isWorkerPaused = false;
  /** 当前正在播放的 AudioBufferSourceNode 实例 */
  private activeSources: AudioBufferSourceNode[] = [];
  /** Source 代际号，用于忽略 stop/seek 后的旧回调 */
  private sourceGeneration = 0;
  /** 解码是否已完成 */
  private isDecodingFinished = false;
  /** ended 事件是否已经派发 */
  private endedDispatched = false;
  /** 当前播放速率 */
  private currentTempo = 1.0;

  /** 锚点时刻的 AudioContext 时间 */
  private anchorWallTime = 0;
  /** 锚点时刻的 音频资源 时间（00:00） */
  private anchorSourceTime = 0;
  /** 连续解码游标，用于校验后续 chunk 的时间戳 */
  private sourceTimeCursor = 0;
  /** 下一块音频是否允许重新建立播放锚点 */
  private shouldAnchorNextChunk = true;

  /** 时间更新定时器 ID */
  private timeUpdateIntervalId: ReturnType<typeof setInterval> | null = null;

  /** 共享环形缓冲区 */
  private ringBuffer: SharedRingBuffer | null = null;
  /** 共享内存的头部（用于同步） */
  private sabHeader: Int32Array | null = null;
  /** Fetch 请求的 AbortController */
  private fetchController: AbortController | null = null;
  /** 是否为流式加载 */
  private isStreaming = false;
  /** 流式加载来源 */
  private streamSource: "network" | "local" | null = null;
  /** 当前加载的 URL */
  private currentUrl: string | null = null;
  /** 文件总大小 */
  private fileSize = 0;

  /** 消息 ID 计数器 */
  private msgIdCounter = 0;

  /**
   * 是否正在等待 Seek 完成，
   * 用于丢弃 Worker 在 Seek 完成前发来的旧数据
   */
  // TODO: 或许应该给 load 方法添加一个开始时间参数
  private isPendingSeek = false;

  private pendingRequests = new Map<
    number,
    {
      resolve: (value?: unknown) => void;
      reject: (reason?: Error) => void;
      timer: number;
      type: WorkerRequest["type"];
    }
  >();

  public readonly capabilities: EngineCapabilities = {
    supportsRate: true,
    supportsSinkId: true,
    supportsEqualizer: true,
    supportsSpectrum: true,
  };

  constructor() {
    super();
  }

  public get state() {
    return this.playerState;
  }
  public get duration() {
    return this.metadata?.duration || 0;
  }
  public get currentTime() {
    if (!this.audioCtx) return 0;
    const wallDelta = this.audioCtx.currentTime - this.anchorWallTime;
    const currentPosition = this.anchorSourceTime + wallDelta * this.currentTempo;
    return clampPlaybackTime(currentPosition, this.duration);
  }

  public get audioInfo() {
    return this.metadata;
  }

  public get src(): string {
    return this.currentUrl || "";
  }

  public get paused(): boolean {
    return (
      this.playerState === "paused" ||
      this.playerState === "idle" ||
      this.playerState === "error" ||
      this.playerState === "ready"
    );
  }

  public getErrorCode(): number {
    return 0;
  }

  public getChannels(): number {
    const channels = this.metadata?.channels ?? 2;
    console.log(`[FFmpegAudioPlayer] getChannels 返回: ${channels}, metadata:`, this.metadata);
    return channels;
  }

  public getChannelInfo(): AudioChannelInfo {
    const channels = this.metadata?.channels;
    return {
      channels,
      source: "ffmpeg",
      reliable: Number.isFinite(channels) && Number(channels) > 0,
    };
  }

  private requestWorker<T = void>(
    msg: DistributiveOmit<WorkerRequest, "id">,
    transfer: Transferable[] = [],
    timeoutMs = 5000,
  ): Promise<T> {
    if (!this.worker) {
      return Promise.reject(new Error("Worker not initialized"));
    }

    const id = ++this.msgIdCounter;
    const requestPayload = { ...msg, id } as WorkerRequest;

    return new Promise<T>((resolve, reject) => {
      const timer = self.setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Worker request timed out (type: ${msg.type}, id: ${id})`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value?: unknown) => void,
        reject: reject as (reason?: Error) => void,
        timer,
        type: msg.type,
      });

      this.worker?.postMessage(requestPayload, transfer);
    });
  }

  public async load(url: string | File) {
    await this.reset();
    this.dispatch("loadstart");

    this.init();
    if (this.audioCtx && this.audioCtx.state === "running") {
      await this.audioCtx.suspend().catch(() => undefined);
    }

    try {
      if (this.worker) {
        this.worker.terminate();
        this.worker = null;
      }

      this.worker = new FFmpegWorker();
      const file: File | null = url instanceof File ? url : null;

      if (file) {
        this.currentUrl = `local://${file.name}`;
        this.setupWorkerListeners();
        this.isStreaming = false;
        this.streamSource = null;
        await this.requestWorker(
          {
            type: "INIT",
            file: file,
            chunkSize: 4096 * 8,
            paused: true,
          },
          [],
          FFMPEG_INIT_TIMEOUT,
        );
        this.isWorkerPaused = true;
      } else if (typeof url === "string" && url.startsWith("file://")) {
        await this.loadLocalFileSrc(url);
      } else {
        await this.loadSrc(url as string);
      }
    } catch (e) {
      const err = toError(e);
      console.error("[Player] Load error:", err);
      this.dispatch("error", {
        originalEvent: new Event("error"),
        errorCode: AudioErrorCode.DECODE,
      });
      throw err;
    }
  }

  private prepareStream(url: string, fileSize: number, source: "network" | "local") {
    this.fileSize = fileSize;
    this.currentUrl = url;

    const BUFFER_SIZE = 2 * 1024 * 1024;
    this.ringBuffer = SharedRingBuffer.create(BUFFER_SIZE);

    const sab = this.ringBuffer.sharedArrayBuffer;
    this.sabHeader = new Int32Array(sab, 0, IDX_SEEK_GEN + 1);

    this.setupWorkerListeners();
    this.isStreaming = true;
    this.streamSource = source;

    return sab;
  }

  private async loadLocalFileSrc(url: string) {
    const statResult = (await window.electron.ipcRenderer.invoke(
      FFMPEG_LOCAL_FILE_IPC.STAT,
      url,
    )) as FfmpegLocalFileStatResult;

    if (!statResult.ok) {
      throw new Error(statResult.error);
    }

    const sab = this.prepareStream(url, statResult.size, "local");
    const initWorkerPromise = this.requestWorker(
      {
        type: "INIT_STREAM",
        fileSize: this.fileSize,
        sab,
        chunkSize: 4096 * 8,
        paused: true,
      },
      [],
      FFMPEG_INIT_TIMEOUT,
    );

    this.runLocalFileLoop(url, 0, this.fileSize);
    await initWorkerPromise;
    this.isWorkerPaused = true;
  }

  private async loadSrc(url: string) {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) {
      throw new Error(`Failed to fetch metadata: ${response.statusText}`);
    }
    const contentLength = response.headers.get("Content-Length");
    if (!contentLength) {
      await this.loadFullDownload(url);
      return;
    }

    const fileSize = parseInt(contentLength, 10);
    const sab = this.prepareStream(url, fileSize, "network");

    const initWorkerPromise = this.requestWorker(
      {
        type: "INIT_STREAM",
        fileSize: this.fileSize,
        sab,
        chunkSize: 4096 * 8,
        paused: true,
      },
      [],
      FFMPEG_INIT_TIMEOUT,
    );

    this.runFetchLoop(url, 0, this.fileSize);
    await initWorkerPromise;
    this.isWorkerPaused = true;
  }

  private async loadFullDownload(url: string) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.statusText}`);
    }

    const blob = await response.blob();
    const name = this.getDownloadFileName(url);
    const file = new File([blob], name || "stream.audio");

    this.currentUrl = url;
    this.setupWorkerListeners();
    this.isStreaming = false;
    this.streamSource = null;

    await this.requestWorker(
      {
        type: "INIT",
        file,
        chunkSize: 4096 * 8,
        paused: true,
      },
      [],
      FFMPEG_INIT_TIMEOUT,
    );
    this.isWorkerPaused = true;
  }

  /**
   * 当音频图谱初始化完成时调用
   * FFmpeg 播放器不需要额外的初始化操作
   */
  protected onGraphInitialized(): void {}

  private async runFetchLoop(url: string, startOffset: number, totalSize: number) {
    if (this.fetchController) {
      this.fetchController.abort();
    }
    this.fetchController = new AbortController();
    const signal = this.fetchController.signal;

    if (startOffset >= totalSize) {
      this.ringBuffer?.setEOF();
      this.notifyWorkerSeek();
      return;
    }

    try {
      const safeStartOffset = Math.floor(startOffset);
      const response = await fetch(url, {
        headers: {
          Range: `bytes=${safeStartOffset}-`,
        },
        signal,
      });

      if (response.status === 416) {
        this.ringBuffer?.setEOF();
        this.notifyWorkerSeek();
        return;
      }

      if (!response.ok && response.status !== 206) {
        throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) throw new Error("Response body is null");

      const reader = response.body.getReader();

      this.notifyWorkerSeek();

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          this.ringBuffer?.setEOF();
          break;
        }

        if (value && this.ringBuffer) {
          await this.ringBuffer.write(value);
        }

        if (signal.aborted) break;
      }
    } catch (e) {
      const err = toError(e);
      if (err.name === "AbortError") {
        return;
      } else {
        console.error("[Player] Stream error:", err);
        this.dispatch("error", {
          originalEvent: new Event("error"),
          errorCode: AudioErrorCode.NETWORK,
        });
      }
    }
  }

  private async runLocalFileLoop(url: string, startOffset: number, totalSize: number) {
    if (this.fetchController) {
      this.fetchController.abort();
    }
    this.fetchController = new AbortController();
    const signal = this.fetchController.signal;

    if (startOffset >= totalSize) {
      this.ringBuffer?.setEOF();
      this.notifyWorkerSeek();
      return;
    }

    try {
      let offset = Math.max(0, Math.floor(startOffset));
      this.notifyWorkerSeek();

      while (offset < totalSize) {
        if (signal.aborted) break;

        const length = Math.min(LOCAL_FILE_READ_CHUNK_SIZE, totalSize - offset);
        const result = (await window.electron.ipcRenderer.invoke(
          FFMPEG_LOCAL_FILE_IPC.READ,
          url,
          offset,
          length,
        )) as FfmpegLocalFileReadResult;

        if (signal.aborted) break;

        if (!result.ok) {
          throw new Error(result.error);
        }

        if (result.bytesRead <= 0) {
          this.ringBuffer?.setEOF();
          break;
        }

        if (this.ringBuffer) {
          await this.ringBuffer.write(new Uint8Array(result.data));
        }

        offset += result.bytesRead;
      }

      if (!signal.aborted) {
        this.ringBuffer?.setEOF();
      }
    } catch (e) {
      if (signal.aborted) return;

      const err = toError(e);
      console.error("[Player] Local file stream error:", err);
      this.ringBuffer?.setEOF();
      this.dispatch("error", {
        originalEvent: new Event("error"),
        errorCode: AudioErrorCode.NETWORK,
      });
    }
  }

  protected async doPlay(): Promise<void> {
    const previousState = this.playerState;
    this.dispatch("play");

    if (this.audioCtx?.state === "suspended") {
      await this.audioCtx.resume();
    }

    if (this.audioCtx) {
      const now = this.audioCtx.currentTime;
      if (this.nextStartTime < now) {
        this.nextStartTime = now;
        this.shouldAnchorNextChunk = true;
      }
    }

    this.playerState = "playing";
    try {
      if (this.worker && this.isWorkerPaused) {
        this.isWorkerPaused = false;
        await this.requestWorker({ type: "RESUME" }).catch((e) => {
          this.isWorkerPaused = true;
          throw e;
        });
      }
    } catch (e) {
      this.playerState = previousState;
      throw e;
    }

    this.dispatch("playing");
    this.startTimeUpdate();
  }

  protected async doPause(): Promise<void> {
    this.dispatch("pause");
    this.stopTimeUpdate();

    if (this.audioCtx) {
      const frozenTime = this.currentTime;
      this.syncTimeAnchor(this.audioCtx.currentTime, frozenTime);
    }

    if (this.worker) {
      this.isWorkerPaused = true;
      await this.requestWorker({ type: "PAUSE" }).catch(() => {
        this.isWorkerPaused = false;
      });
    }
  }

  public override stop(): void {
    this.stopTimeUpdate();
    this.stopActiveSources();
    this.isDecodingFinished = false;
    this.isPendingSeek = false;
    this.endedDispatched = false;
    if (this.audioCtx) {
      const now = this.audioCtx.currentTime;
      this.nextStartTime = now;
      this.sourceTimeCursor = 0;
      this.shouldAnchorNextChunk = true;
      this.syncTimeAnchor(now, 0);
    }
    this.isWorkerPaused = true;
    if (this.worker) {
      void this.requestWorker({ type: "PAUSE" }).catch((e) => {
        if (toError(e).message === "Player reset") return;
        console.warn("[FFmpegAudioPlayer] stop pause worker failed:", e);
      });
    }
    this.dispatch("pause");
  }

  private cancelPendingSeekRequests(reason = SEEK_SUPERSEDED_ERROR) {
    for (const [id, req] of this.pendingRequests) {
      if (req.type !== "SEEK") continue;
      clearTimeout(req.timer);
      req.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }

  protected async doSeek(time: number): Promise<void> {
    if (!this.worker) return;
    this.cancelPendingSeekRequests();
    this.dispatch("seeking");
    this.stopActiveSources();
    this.activeSources = [];
    this.isDecodingFinished = false;
    this.isPendingSeek = true;
    this.endedDispatched = false;
    const shouldPauseAfterSeek = this.playerState !== "playing";

    try {
      await this.requestWorker(
        {
          type: "SEEK",
          seekTime: time,
          paused: shouldPauseAfterSeek,
        },
        [],
        FFMPEG_SEEK_TIMEOUT,
      );
    } catch (e) {
      if (toError(e).message === SEEK_SUPERSEDED_ERROR) return;
      throw e;
    }

    this.dispatch("timeupdate");
  }

  public setRate(value: number): void {
    this.setTempo(value).catch((e) => {
      if (e.message !== "Player reset") {
        console.warn("[FFmpegAudioPlayer] setTempo failed:", e);
      }
    });
  }

  public getRate(): number {
    return this.currentTempo;
  }

  public setAudioDelayCompensation(offset: number): void {
    // FFmpeg 引擎使用独立的时钟同步机制，此设置无效
    void offset;
  }

  public async setTempo(tempo: number) {
    if (!this.worker) return;
    if (tempo === this.currentTempo) return;
    const trueTime = this.currentTime;
    await this.requestWorker({ type: "SET_TEMPO", value: tempo });
    this.currentTempo = tempo;
    await this.doSeek(trueTime);
    this.applyFadeTo(this.volume * this.replayGain, 0);
  }

  protected async doSetSinkId(_deviceId: string): Promise<void> {
    return Promise.resolve();
  }

  private setupWorkerListeners() {
    if (!this.worker) return;

    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const resp = event.data;
      const msgId = resp.id;
      let matchedRequestType: WorkerRequest["type"] | null = null;

      if (this.pendingRequests.has(msgId)) {
        // biome-ignore lint/style/noNonNullAssertion: 肯定有
        const req = this.pendingRequests.get(msgId)!;
        matchedRequestType = req.type;

        if (resp.type === "ERROR") {
          clearTimeout(req.timer);
          req.reject(new Error(resp.error));
          this.pendingRequests.delete(msgId);
          return;
        }

        if (resp.type === "ACK") {
          clearTimeout(req.timer);
          req.resolve();
          this.pendingRequests.delete(msgId);
          return;
        } else if (resp.type === "SEEK_DONE") {
          clearTimeout(req.timer);
          req.resolve();
          this.pendingRequests.delete(msgId);
        } else if (resp.type === "EXPORT_WAV_DONE") {
          clearTimeout(req.timer);
          req.resolve(resp.blob);
          this.pendingRequests.delete(msgId);
          return;
        }
      }

      if (resp.type === "SEEK_NET") {
        if (this.isStreaming && this.ringBuffer && this.currentUrl) {
          if (this.fetchController) {
            this.fetchController.abort();
          }
          this.ringBuffer.reset();
          if (this.streamSource === "local") {
            this.runLocalFileLoop(this.currentUrl, resp.seekOffset, this.fileSize);
          } else {
            this.runFetchLoop(this.currentUrl, resp.seekOffset, this.fileSize);
          }
        }
        return;
      }

      switch (resp.type) {
        case "ERROR":
          console.error("[FFmpegAudioPlayer] Worker error:", resp.error);
          this.dispatch("error", {
            originalEvent: new Event("error"),
            errorCode: AudioErrorCode.DECODE,
          });
          break;
        case "METADATA":
          this.endedDispatched = false;
          this.revokeMetadataCoverUrl();
          this.metadataCoverUrl = this.createMetadataCoverUrl(resp.coverData);
          this.metadata = {
            sampleRate: resp.sampleRate,
            channels: resp.channels,
            duration: resp.duration,
            metadata: resp.metadata,
            encoding: resp.encoding,
            coverUrl: this.metadataCoverUrl ?? undefined,
            bitsPerSample: resp.bitsPerSample,
          };
          if (this.audioCtx) {
            const now = this.audioCtx.currentTime;
            this.syncTimeAnchor(now, 0);
            this.nextStartTime = now;
            this.sourceTimeCursor = 0;
            this.shouldAnchorNextChunk = true;
          }
          this.dispatch("canplay");
          break;
        case "CHUNK":
          if (this.metadata) {
            const didSchedule = this.scheduleChunk(
              resp.data,
              this.metadata.sampleRate,
              this.metadata.channels,
              resp.startTime,
            );

            if (didSchedule && this.audioCtx) {
              const bufferedDuration = this.nextStartTime - this.audioCtx.currentTime;
              if (bufferedDuration > HIGH_WATER_MARK && !this.isWorkerPaused) {
                this.isWorkerPaused = true;
                this.requestWorker({
                  type: "PAUSE",
                }).catch((e) => {
                  console.error("[Player] Failed to pause worker for high water mark:", e);
                  this.isWorkerPaused = false;
                });
              }
            }
          }
          break;
        case "EOF":
          this.isDecodingFinished = true;
          this.checkIfEnded();
          break;
        case "SEEK_DONE":
          if (matchedRequestType !== "SEEK") return;
          this.isPendingSeek = false;
          if (this.audioCtx) {
            const now = this.audioCtx.currentTime;
            this.isWorkerPaused = !!resp.paused;
            this.nextStartTime = now;
            this.sourceTimeCursor = resp.time;
            this.shouldAnchorNextChunk = true;
            this.syncTimeAnchor(now, resp.time);
          }
          this.dispatch("seeked");
          break;
      }
    };
  }

  private notifyWorkerSeek() {
    if (this.sabHeader) {
      Atomics.add(this.sabHeader, IDX_SEEK_GEN, 1);
      Atomics.notify(this.sabHeader, IDX_SEEK_GEN, 1);
    }
  }

  private scheduleChunk(
    planarData: Float32Array,
    sampleRate: number,
    channels: number,
    chunkStartTime: number,
  ): boolean {
    if (!this.audioCtx || !this.inputNode) return false;
    const ctx = this.audioCtx;
    if (
      !shouldAcceptFfmpegChunk({
        isPendingSeek: this.isPendingSeek,
        audioContextState: ctx.state,
        playerState: this.playerState,
      })
    ) {
      return false;
    }

    const safeChannels = channels || 1;
    const frameCount = planarData.length / safeChannels;

    const audioBuffer = ctx.createBuffer(safeChannels, frameCount, sampleRate);

    for (let ch = 0; ch < safeChannels; ch++) {
      const chData = audioBuffer.getChannelData(ch);
      const start = ch * frameCount;
      chData.set(planarData.subarray(start, start + frameCount));
    }

    const now = this.audioCtx.currentTime;

    if (this.nextStartTime < now) {
      this.nextStartTime = now;
      this.shouldAnchorNextChunk = true;
    }

    const scheduledStartTime = this.nextStartTime;
    const timing = resolveFfmpegChunkTiming({
      chunkStartTime,
      expectedStartTime: this.sourceTimeCursor,
      allowAnchor: this.shouldAnchorNextChunk,
    });

    if (timing.shouldSyncAnchor) {
      this.syncTimeAnchor(scheduledStartTime, timing.sourceStartTime);
    }

    this.sourceTimeCursor = timing.sourceStartTime + audioBuffer.duration * this.currentTempo;
    this.shouldAnchorNextChunk = false;

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.inputNode);

    source.start(scheduledStartTime);

    this.nextStartTime += audioBuffer.duration;

    this.activeSources.push(source);

    const generation = this.sourceGeneration;

    source.onended = () => {
      this.disconnectSource(source);
      if (generation !== this.sourceGeneration) return;

      const index = this.activeSources.indexOf(source);
      if (index !== -1) {
        this.activeSources.splice(index, 1);
      }

      if (this.audioCtx && !this.isDecodingFinished) {
        const bufferedDuration = this.nextStartTime - this.audioCtx.currentTime;
        if (
          bufferedDuration < LOW_WATER_MARK &&
          shouldResumeFfmpegWorker({
            playerState: this.playerState,
            isWorkerPaused: this.isWorkerPaused,
          })
        ) {
          this.isWorkerPaused = false;
          this.requestWorker({ type: "RESUME" }).catch((err) => {
            console.error("[Player] Failed to resume worker for low water mark:", err);
            this.isWorkerPaused = true;
          });
        }
      }

      if (this.activeSources.length === 0) {
        if (this.isDecodingFinished) {
          this.checkIfEnded();
        } else if (this.playerState === "playing") {
          this.dispatch("waiting");
        }
      }

      this.checkIfEnded();
    };

    return true;
  }

  private checkIfEnded() {
    const shouldEnd = shouldDispatchFfmpegEnded({
      state: this.state,
      activeSourceCount: this.activeSources.length,
      isDecodingFinished: this.isDecodingFinished,
      currentTime: this.currentTime,
      duration: this.duration,
      endedDispatched: this.endedDispatched,
    });

    if (!shouldEnd) return;
    this.endedDispatched = true;
    this.dispatch("ended");
  }

  private syncTimeAnchor(wallTime: number, sourceTime: number) {
    this.anchorWallTime = wallTime;
    this.anchorSourceTime = sourceTime;
  }

  private disconnectSource(source: AudioBufferSourceNode) {
    try {
      source.disconnect();
    } catch {
      // ignore
    }
  }

  private stopActiveSources() {
    this.sourceGeneration += 1;
    const sources = this.activeSources;
    this.activeSources = [];
    sources.forEach((source) => {
      try {
        source.stop();
      } catch {
        // ignore
      }
      this.disconnectSource(source);
    });
  }

  private startTimeUpdate() {
    this.stopTimeUpdate();
    this.timeUpdateIntervalId = setInterval(() => {
      if (this.state === "playing") {
        this.dispatch("timeupdate");
        this.checkIfEnded();
      }
    }, 250);
  }

  private stopTimeUpdate() {
    if (this.timeUpdateIntervalId !== null) {
      clearInterval(this.timeUpdateIntervalId);
      this.timeUpdateIntervalId = null;
    }
  }

  public override dispatch<K extends keyof AudioEventMap>(
    type: K,
    ...args: GetDetail<AudioEventMap[K]> extends undefined
      ? [detail?: GetDetail<AudioEventMap[K]>]
      : [detail: GetDetail<AudioEventMap[K]>]
  ): boolean {
    switch (type) {
      case "loadstart":
        this.playerState = "loading";
        break;
      case "canplay":
        if (this.playerState !== "playing" && this.playerState !== "error") {
          this.playerState = "ready";
        }
        break;
      case "playing":
        this.playerState = "playing";
        break;
      case "pause":
        this.playerState = "paused";
        break;
      case "ended":
        this.playerState = "idle";
        break;
      case "error":
        this.playerState = "error";
        break;
      case "emptied":
        this.playerState = "idle";
        break;
    }
    return super.dispatch(type, ...args);
  }

  private async reset() {
    this.stopTimeUpdate();
    if (this.audioCtx?.state === "running") {
      await this.audioCtx.suspend().catch(() => undefined);
    }
    this.stopActiveSources();
    this.activeSources = [];

    for (const req of this.pendingRequests.values()) {
      clearTimeout(req.timer);
      req.reject(new Error("Player reset"));
    }
    this.pendingRequests.clear();

    this.metadata = null;
    this.revokeMetadataCoverUrl();
    this.isWorkerPaused = false;
    this.isDecodingFinished = false;
    this.endedDispatched = false;
    this.nextStartTime = this.audioCtx ? this.audioCtx.currentTime : 0;
    this.sourceTimeCursor = 0;
    this.shouldAnchorNextChunk = true;
    this.isPendingSeek = false;

    if (this.fetchController) {
      this.fetchController.abort();
      this.fetchController = null;
    }
    this.isStreaming = false;
    this.streamSource = null;
    this.ringBuffer = null;
    this.sabHeader = null;

    this.dispatch("emptied");
  }

  private revokeMetadataCoverUrl() {
    if (!this.metadataCoverUrl) return;
    URL.revokeObjectURL(this.metadataCoverUrl);
    this.metadataCoverUrl = null;
  }

  private createMetadataCoverUrl(coverData?: Uint8Array): string | null {
    if (!coverData) return null;
    const coverBytes = new Uint8Array(coverData.byteLength);
    coverBytes.set(coverData);
    return URL.createObjectURL(new Blob([coverBytes.buffer]));
  }

  private getDownloadFileName(url: string): string {
    const rawName = url.split("/").pop()?.split("?")[0] || "stream.audio";
    try {
      return decodeURIComponent(rawName) || "stream.audio";
    } catch {
      return rawName || "stream.audio";
    }
  }

  public override destroy() {
    void this.reset();
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    super.destroy();
  }
}
