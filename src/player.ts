import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { extname } from "node:path";

interface PlayerSpec {
  command: string;
  args: (file: string) => string[];
  /** Arguments that make the player read an mp3 stream from stdin, for players that can. */
  stdinArgs?: string[];
  formats: readonly string[];
}

const FFPLAY: PlayerSpec = {
  command: "ffplay",
  args: (f) => ["-nodisp", "-autoexit", "-loglevel", "error", f],
  stdinArgs: ["-nodisp", "-autoexit", "-loglevel", "error", "-f", "mp3", "-i", "pipe:0"],
  formats: ["mp3", "wav", "opus", "ogg", "flac", "m4a", "aac"],
};

const MPV: PlayerSpec = {
  command: "mpv",
  args: (f) => ["--no-video", "--really-quiet", f],
  stdinArgs: ["--no-video", "--really-quiet", "-"],
  formats: FFPLAY.formats,
};

const MPG123: PlayerSpec = {
  command: "mpg123",
  args: (f) => ["-q", f],
  stdinArgs: ["-q", "-"],
  formats: ["mp3"],
};

const AFPLAY: PlayerSpec = {
  command: "afplay",
  args: (f) => [f],
  formats: ["mp3", "wav", "m4a", "aac", "aiff", "caf"],
};

/** File players per platform, in order of preference. */
const PLAYERS: Partial<Record<NodeJS.Platform, PlayerSpec[]>> = {
  darwin: [AFPLAY, FFPLAY, MPV],
  linux: [
    FFPLAY,
    MPV,
    MPG123,
    { command: "paplay", args: (f) => [f], formats: ["wav", "ogg"] },
    { command: "aplay", args: (f) => ["-q", f], formats: ["wav"] },
  ],
  win32: [
    FFPLAY,
    {
      command: "powershell",
      args: (f) => [
        "-NoProfile",
        "-Command",
        `(New-Object System.Media.SoundPlayer '${f.replace(/'/g, "''")}').PlaySync()`,
      ],
      formats: ["wav"],
    },
  ],
};

/**
 * Players that can play an mp3 stream from stdin, fastest to start first:
 * mpg123 starts in about 50 ms, ffplay and mpv in about 300 ms (measured
 * 2026-09-06), and that start-up is on the path to the first spoken word.
 * Same list on every platform.
 */
const STREAMING_PLAYERS: PlayerSpec[] = [MPG123, FFPLAY, MPV];

let cachedPlayer: PlayerSpec | null | undefined;
let cachedStreamingPlayer: PlayerSpec | null | undefined;

function commandExists(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

export function findPlayer(): PlayerSpec | null {
  if (cachedPlayer === undefined) {
    const specs = PLAYERS[process.platform] ?? PLAYERS.linux ?? [];
    cachedPlayer = specs.find((spec) => commandExists(spec.command)) ?? null;
  }
  return cachedPlayer;
}

/** The player used for streamed speech, or null when none of the stdin-capable players is installed. */
export function findStreamingPlayer(): PlayerSpec | null {
  if (cachedStreamingPlayer === undefined) {
    cachedStreamingPlayer = STREAMING_PLAYERS.find((spec) => commandExists(spec.command)) ?? null;
  }
  return cachedStreamingPlayer;
}

/** Synthesis format to request when the audio is destined for local playback. */
export function playbackFormat(): "mp3" | "wav" {
  const player = findPlayer();
  if (player && !player.formats.includes("mp3")) return "wav";
  return "mp3";
}

export const pauseSupported = process.platform !== "win32";

export function noPlayerMessage(): string {
  switch (process.platform) {
    case "linux":
      return "No audio player found. Install one of: ffmpeg (ffplay), mpv, mpg123, or pulseaudio-utils (paplay).";
    case "win32":
      return "No audio player found. Install ffmpeg (ffplay) and make sure it is on PATH.";
    default:
      return "No audio player found on this machine.";
  }
}

export interface PlaybackResult {
  stopped: boolean;
}

export interface PlayerHandle {
  pause(): void;
  resume(): void;
  stop(): void;
  done: Promise<PlaybackResult>;
}

/** A player that is being fed audio through stdin. */
export interface StreamHandle extends PlayerHandle {
  write(chunk: Uint8Array): void;
  /** Signal the end of the audio; the player finishes what it has buffered and exits. */
  end(): void;
}

const activeChildren = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of activeChildren) child.kill("SIGKILL");
});

function attach(spec: PlayerSpec, child: ChildProcess): PlayerHandle {
  activeChildren.add(child);

  let stopped = false;
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    if (stderr.length < 4096) stderr += d.toString();
  });

  const done = new Promise<PlaybackResult>((resolve, reject) => {
    child.on("error", (err) => {
      activeChildren.delete(child);
      reject(new Error(`Failed to start ${spec.command}: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      activeChildren.delete(child);
      if (stopped) {
        resolve({ stopped: true });
      } else if (code === 0) {
        resolve({ stopped: false });
      } else {
        const why = stderr.trim() || `exit code ${code ?? `signal ${signal}`}`;
        reject(new Error(`${spec.command} failed to play the audio: ${why}`));
      }
    });
  });

  return {
    pause() {
      if (pauseSupported) child.kill("SIGSTOP");
    },
    resume() {
      if (pauseSupported) child.kill("SIGCONT");
    },
    stop() {
      stopped = true;
      if (pauseSupported) child.kill("SIGCONT");
      child.kill("SIGTERM");
    },
    done,
  };
}

function start(spec: PlayerSpec, file: string): PlayerHandle {
  const child = spawn(spec.command, spec.args(file), { stdio: ["ignore", "ignore", "pipe"] });
  return attach(spec, child);
}

/** Play a local audio file. Returns null when no player is available. */
export function playFile(file: string): PlayerHandle | null {
  const spec = findPlayer();
  return spec ? start(spec, file) : null;
}

/**
 * Players with a small fixed start-up cost, fastest first, for short clips
 * where starting the player takes longer than the audio. Measured on a Mac:
 * mpg123 about 50 ms, ffplay and mpv about 300 ms, while afplay needs 0.4 to
 * 0.9 s just to start and stop. Only mp3-capable players are here, so the
 * format check below matters.
 */
const QUICK_PLAYERS: PlayerSpec[] = [MPG123, FFPLAY, MPV];

/** Play a short clip through the fastest-starting installed player that can play its format, else the platform file player. */
export function playClip(file: string): PlayerHandle | null {
  const ext = extname(file).slice(1).toLowerCase();
  const spec = QUICK_PLAYERS.find((s) => s.formats.includes(ext) && commandExists(s.command)) ?? findPlayer();
  return spec ? start(spec, file) : null;
}

/** Start a player that reads mp3 from stdin. Returns null when no stdin-capable player is installed. */
export function playStream(): StreamHandle | null {
  const spec = findStreamingPlayer();
  if (!spec?.stdinArgs) return null;
  const child = spawn(spec.command, spec.stdinArgs, { stdio: ["pipe", "ignore", "pipe"] });
  const stdin = child.stdin;
  // EPIPE arrives when the player quits before the stream ends; the exit handler reports that case.
  stdin?.on("error", () => {});
  const handle = attach(spec, child);
  return {
    ...handle,
    write(chunk) {
      if (stdin && !stdin.destroyed && stdin.writable) stdin.write(chunk);
    },
    end() {
      if (stdin && !stdin.destroyed) stdin.end();
    },
  };
}
