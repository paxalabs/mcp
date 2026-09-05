import { spawn, spawnSync, type ChildProcess } from "node:child_process";

interface PlayerSpec {
  command: string;
  args: (file: string) => string[];
  formats: readonly string[];
}

const FFPLAY: PlayerSpec = {
  command: "ffplay",
  args: (f) => ["-nodisp", "-autoexit", "-loglevel", "error", f],
  formats: ["mp3", "wav", "opus", "ogg", "flac", "m4a", "aac"],
};

const PLAYERS: Partial<Record<NodeJS.Platform, PlayerSpec[]>> = {
  darwin: [
    {
      command: "afplay",
      args: (f) => [f],
      formats: ["mp3", "wav", "m4a", "aac", "aiff", "caf"],
    },
    FFPLAY,
  ],
  linux: [
    FFPLAY,
    { command: "mpv", args: (f) => ["--no-video", "--really-quiet", f], formats: FFPLAY.formats },
    { command: "mpg123", args: (f) => ["-q", f], formats: ["mp3"] },
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

let cachedPlayer: PlayerSpec | null | undefined;

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

const activeChildren = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of activeChildren) child.kill("SIGKILL");
});

/** Play a local audio file. Returns null when no player is available. */
export function playFile(file: string): PlayerHandle | null {
  const spec = findPlayer();
  if (!spec) return null;

  const child = spawn(spec.command, spec.args(file), {
    stdio: ["ignore", "ignore", "pipe"],
  });
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
