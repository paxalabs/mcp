import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PaxaApiError } from "./api.js";
import {
  noPlayerMessage,
  pauseSupported,
  playbackFormat,
  playFile,
  findPlayer,
  type PlayerHandle,
} from "./player.js";

export type SegmentTerminalStatus = "done" | "failed" | "skipped" | "cleared";
export type SegmentStatus =
  | "pending"
  | "synthesizing"
  | "ready"
  | "playing"
  | SegmentTerminalStatus;

export interface Segment {
  id: number;
  kind: "tts" | "file";
  text?: string;
  voice?: string;
  file?: string;
  label: string;
  priority: boolean;
  status: SegmentStatus;
  error?: string;
}

interface InternalSegment extends Segment {
  synthPromise?: Promise<void>;
  resolvers: Array<(segment: Segment) => void>;
}

const TERMINAL: ReadonlySet<SegmentStatus> = new Set(["done", "failed", "skipped", "cleared"]);
const HISTORY_LIMIT = 50;

export interface EngineStatus {
  state: "idle" | "playing" | "paused";
  player: string | null;
  pauseSupported: boolean;
  current: { id: number; label: string; status: SegmentStatus } | null;
  pendingCount: number;
  pendingChars: number;
  nextUp: Array<{ id: number; label: string; status: SegmentStatus }>;
  recentlyFinished: Array<{ id: number; label: string; status: SegmentStatus }>;
  failures: Array<{ id: number; label: string; error: string }>;
}

function label(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 60 ? flat : flat.slice(0, 57) + "...";
}

/**
 * The single owner of the audio device. Every sound (speak, queued long-form
 * reads, replayed files) flows through one ordered queue, so audio never
 * overlaps. While a segment plays, the next TTS segment is synthesized ahead
 * of time so long reads flow without gaps.
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

  constructor(
    private readonly synthesize: (
      text: string,
      voice: string,
      format: "mp3" | "wav",
    ) => Promise<Buffer>,
  ) {}

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
    const brief = (s: InternalSegment) => ({ id: s.id, label: s.label, status: s.status });
    return {
      state: this.paused ? "paused" : this.current ? "playing" : "idle",
      player: findPlayer()?.command ?? null,
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
    const upNext = this.pending.find((s) => s.kind === "tts" && s.status === "pending");
    if (upNext) this.ensureSynth(upNext).catch(() => {});

    try {
      if (segment.kind === "tts") await this.ensureSynth(segment);
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

  private ensureSynth(segment: InternalSegment): Promise<void> {
    if (!segment.synthPromise) {
      if (segment.status === "pending") segment.status = "synthesizing";
      const format = playbackFormat();
      segment.synthPromise = (async () => {
        const audio = await this.synthesize(segment.text as string, segment.voice as string, format);
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
