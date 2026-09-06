import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PaxaApiError } from "./api.js";
import {
  findPlayer,
  findStreamingPlayer,
  noPlayerMessage,
  pauseSupported,
  playbackFormat,
  playFile,
  playStream,
  type PlayerHandle,
} from "./player.js";

export type SegmentTerminalStatus = "done" | "failed" | "skipped" | "cleared";
export type SegmentStatus =
  | "pending"
  | "synthesizing"
  | "ready"
  | "playing"
  | SegmentTerminalStatus;

export type Delivery = "streamed" | "buffered";

export interface Segment {
  id: number;
  kind: "tts" | "file";
  text?: string;
  voice?: string;
  file?: string;
  label: string;
  priority: boolean;
  status: SegmentStatus;
  /** How the audio reached the player: streamed while synthesizing, or from a fully downloaded file. */
  delivery?: Delivery;
  error?: string;
}

interface InternalSegment extends Segment {
  synthPromise?: Promise<void>;
  resolvers: Array<(segment: Segment) => void>;
}

/** How the engine gets audio. Both calls synthesize the given text with the given voice. */
export interface Synthesizer {
  /** Full download, used to synthesize ahead while something else plays. */
  buffered(text: string, voice: string, format: "mp3" | "wav"): Promise<Buffer>;
  /** Chunked mp3 that starts arriving while synthesis runs. Optional; without it everything is buffered. */
  stream?(text: string, voice: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}

const TERMINAL: ReadonlySet<SegmentStatus> = new Set(["done", "failed", "skipped", "cleared"]);
const HISTORY_LIMIT = 50;

interface SegmentBrief {
  id: number;
  label: string;
  status: SegmentStatus;
  delivery?: Delivery;
}

export interface EngineStatus {
  state: "idle" | "playing" | "paused";
  player: string | null;
  streamingPlayer: string | null;
  pauseSupported: boolean;
  current: SegmentBrief | null;
  pendingCount: number;
  pendingChars: number;
  nextUp: SegmentBrief[];
  recentlyFinished: SegmentBrief[];
  failures: Array<{ id: number; label: string; error: string }>;
}

function label(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 60 ? flat : flat.slice(0, 57) + "...";
}

/**
 * The single owner of the audio device. Every sound (speak, queued long-form
 * reads, replayed files) flows through one ordered queue, so audio never
 * overlaps. A speech segment whose turn comes before it was synthesized ahead
 * is streamed straight into the player, so the first words play while the rest
 * is still being synthesized. While a segment plays, the next one is
 * synthesized ahead so long reads flow without gaps. At most one synthesis
 * request is in flight at a time.
 */
export class SpeechEngine {
  private pending: InternalSegment[] = [];
  private current: InternalSegment | null = null;
  private handle: PlayerHandle | null = null;
  private paused = false;
  private pauseWaiters: Array<() => void> = [];
  private looping = false;
  private nextId = 1;
  private history: InternalSegment[] = [];
  private tmpDir: string | null = null;

  constructor(private readonly synth: Synthesizer) {}

  enqueueTts(texts: string[], voice: string, priority: boolean): Segment[] {
    const segments = texts.map((text): InternalSegment => {
      return {
        id: this.nextId++,
        kind: "tts",
        text,
        voice,
        label: label(text),
        priority,
        status: "pending",
        resolvers: [],
      };
    });
    this.insert(segments, priority);
    this.kickLoop();
    return segments;
  }

  enqueueFile(file: string): Segment {
    const segment: InternalSegment = {
      id: this.nextId++,
      kind: "file",
      file,
      label: label(file),
      priority: true,
      status: "ready",
      resolvers: [],
    };
    this.insert([segment], true);
    this.kickLoop();
    return segment;
  }

  private insert(segments: InternalSegment[], priority: boolean): void {
    if (priority) {
      let i = 0;
      while (i < this.pending.length && this.pending[i]?.priority) i++;
      this.pending.splice(i, 0, ...segments);
    } else {
      this.pending.push(...segments);
    }
  }

  /** Resolves once the segment reaches a terminal status. */
  waitFor(segment: Segment): Promise<Segment> {
    const internal = segment as InternalSegment;
    if (TERMINAL.has(internal.status)) return Promise.resolve(internal);
    return new Promise((resolve) => internal.resolvers.push(resolve));
  }

  pause(): { changed: boolean; reason?: string } {
    if (!pauseSupported) {
      return { changed: false, reason: "Pause is not supported on Windows. Use clear to stop." };
    }
    if (this.paused) return { changed: false, reason: "Playback is already paused." };
    if (!this.current && this.pending.length === 0) {
      return { changed: false, reason: "Nothing is playing or queued." };
    }
    this.paused = true;
    this.handle?.pause();
    return { changed: true };
  }

  resume(): { changed: boolean; reason?: string } {
    if (!this.paused) return { changed: false, reason: "Playback is not paused." };
    this.paused = false;
    this.handle?.resume();
    for (const wake of this.pauseWaiters.splice(0)) wake();
    return { changed: true };
  }

  skip(): { changed: boolean; reason?: string } {
    if (!this.current) return { changed: false, reason: "Nothing is playing to skip." };
    if (this.handle) {
      this.handle.stop();
    } else {
      this.current.status = "skipped";
    }
    return { changed: true };
  }

  clear(): { clearedCurrent: boolean; clearedPending: number } {
    const cleared = this.pending.splice(0);
    for (const segment of cleared) {
      segment.status = "cleared";
      this.settle(segment);
    }
    const clearedCurrent = this.current !== null;
    if (this.current) {
      this.current.status = "cleared";
      this.handle?.stop();
    }
    this.paused = false;
    for (const wake of this.pauseWaiters.splice(0)) wake();
    return { clearedCurrent, clearedPending: cleared.length };
  }

  status(): EngineStatus {
    const brief = (s: InternalSegment): SegmentBrief => {
      const out: SegmentBrief = { id: s.id, label: s.label, status: s.status };
      if (s.delivery) out.delivery = s.delivery;
      return out;
    };
    return {
      state: this.paused ? "paused" : this.current ? "playing" : "idle",
      player: findPlayer()?.command ?? null,
      streamingPlayer: this.synth.stream ? (findStreamingPlayer()?.command ?? null) : null,
      pauseSupported,
      current: this.current ? brief(this.current) : null,
      pendingCount: this.pending.length,
      pendingChars: this.pending.reduce((sum, s) => sum + (s.text?.length ?? 0), 0),
      nextUp: this.pending.slice(0, 3).map(brief),
      recentlyFinished: this.history.slice(-3).map(brief),
      failures: this.history
        .filter((s) => s.status === "failed")
        .slice(-5)
        .map((s) => ({ id: s.id, label: s.label, error: s.error ?? "unknown error" })),
    };
  }

  dispose(): void {
    this.clear();
    if (this.tmpDir) {
      rmSync(this.tmpDir, { recursive: true, force: true });
      this.tmpDir = null;
    }
  }

  private kickLoop(): void {
    if (this.looping) return;
    this.looping = true;
    void this.loop().finally(() => {
      this.looping = false;
      if (this.pending.length > 0) this.kickLoop();
    });
  }

  private async loop(): Promise<void> {
    for (;;) {
      const segment = this.pending.shift();
      if (!segment) return;
      this.current = segment;
      await this.runSegment(segment);
      this.current = null;
      this.settle(segment);
    }
  }

  private async runSegment(segment: InternalSegment): Promise<void> {
    try {
      const canStream = segment.kind === "tts" && !segment.synthPromise && !!this.synth.stream && !!findStreamingPlayer();
      if (canStream) {
        await this.pauseGate();
        if (TERMINAL.has(segment.status)) return;
        await this.streamSegment(segment);
        return;
      }

      if (segment.kind === "tts") {
        segment.delivery = "buffered";
        await this.ensureSynth(segment);
      }
      this.synthesizeAhead();
      await this.pauseGate();
      if (TERMINAL.has(segment.status)) return;

      segment.status = "playing";
      const handle = playFile(segment.file as string);
      if (!handle) throw new Error(noPlayerMessage());
      this.handle = handle;
      if (this.paused) handle.pause();

      const result = await handle.done;
      this.handle = null;
      if (segment.status === "playing") {
        segment.status = result.stopped ? "skipped" : "done";
      }
    } catch (err) {
      this.handle = null;
      if (segment.status !== "cleared") {
        segment.status = "failed";
        segment.error =
          err instanceof PaxaApiError ? err.display() : err instanceof Error ? err.message : String(err);
      }
    }
  }

  /** Stream a segment straight into the player while the API is still synthesizing it. */
  private async streamSegment(segment: InternalSegment): Promise<void> {
    const stream = this.synth.stream as NonNullable<Synthesizer["stream"]>;
    segment.status = "synthesizing";
    segment.delivery = "streamed";

    // Start the player before the request goes out, so its start-up (about
    // 50 ms for mpg123, 300 ms for ffplay) overlaps the network round trip
    // instead of adding to the time to the first word.
    const handle = playStream();
    if (!handle) throw new Error(noPlayerMessage());
    this.handle = handle;
    if (this.paused) handle.pause();
    const controller = new AbortController();
    let playerFailure: unknown;
    // If the player stops early (skip, clear, or a player failure), stop pulling audio.
    handle.done.then(
      (r) => {
        if (r.stopped) controller.abort();
      },
      (err: unknown) => {
        playerFailure = err;
        controller.abort();
      },
    );

    let body: ReadableStream<Uint8Array>;
    try {
      body = await stream(segment.text as string, segment.voice as string, controller.signal);
    } catch (err) {
      handle.stop();
      this.handle = null;
      if (playerFailure !== undefined) throw playerFailure;
      if (controller.signal.aborted) {
        // Skipped or cleared while the request was in flight; clear already set its status.
        if (segment.status === "synthesizing") segment.status = "skipped";
        return;
      }
      throw err;
    }
    if (TERMINAL.has(segment.status)) {
      // Cleared while the request was being opened.
      controller.abort();
      handle.stop();
      this.handle = null;
      return;
    }

    const chunks: Buffer[] = [];
    let streamError: unknown;
    try {
      for await (const chunk of body) {
        const buf = Buffer.from(chunk);
        chunks.push(buf);
        if (segment.status === "synthesizing") segment.status = "playing";
        handle.write(buf);
      }
    } catch (err) {
      streamError = err;
    } finally {
      handle.end();
    }
    // The whole audio has arrived, so the next segment can synthesize while this one finishes playing.
    this.synthesizeAhead();

    const result = await handle.done;
    this.handle = null;

    if (chunks.length > 0) {
      const file = join(this.ensureTmpDir(), `segment-${segment.id}.mp3`);
      await writeFile(file, Buffer.concat(chunks));
      segment.file = file;
    }

    if (streamError !== undefined && !controller.signal.aborted) {
      const why = streamError instanceof Error ? streamError.message : String(streamError);
      throw new Error(`The audio stream ended early: ${why}`);
    }
    if (segment.status === "playing" || segment.status === "synthesizing") {
      segment.status = result.stopped ? "skipped" : "done";
    }
  }

  /** Start synthesizing the next pending speech segment, so it is ready when its turn comes. */
  private synthesizeAhead(): void {
    const upNext = this.pending.find((s) => s.kind === "tts" && s.status === "pending");
    if (upNext) this.ensureSynth(upNext).catch(() => {});
  }

  private ensureSynth(segment: InternalSegment): Promise<void> {
    if (!segment.synthPromise) {
      if (segment.status === "pending") segment.status = "synthesizing";
      const format = playbackFormat();
      segment.synthPromise = (async () => {
        const audio = await this.synth.buffered(segment.text as string, segment.voice as string, format);
        const file = join(this.ensureTmpDir(), `segment-${segment.id}.${format}`);
        await writeFile(file, audio);
        segment.file = file;
        if (segment.status === "synthesizing") segment.status = "ready";
      })();
    }
    return segment.synthPromise;
  }

  private async pauseGate(): Promise<void> {
    while (this.paused) {
      await new Promise<void>((resolve) => this.pauseWaiters.push(resolve));
    }
  }

  private settle(segment: InternalSegment): void {
    if (!TERMINAL.has(segment.status)) return;
    for (const resolve of segment.resolvers.splice(0)) resolve(segment);
    this.history.push(segment);
    if (this.history.length > HISTORY_LIMIT) this.history.splice(0, this.history.length - HISTORY_LIMIT);
  }

  private ensureTmpDir(): string {
    if (!this.tmpDir) this.tmpDir = mkdtempSync(join(tmpdir(), "paxa-mcp-"));
    return this.tmpDir;
  }
}
