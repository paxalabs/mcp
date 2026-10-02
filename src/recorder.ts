// Microphone capture for the listen tool: 16 kHz, mono, signed 16-bit PCM on
// stdout, which is what the realtime transcription socket takes. Stock macOS
// and Windows ship no command-line recorder, so one has to be installed:
// ffmpeg or sox on macOS and Windows; ffmpeg, sox, parecord, or arecord on
// Linux. PAXA_MIC names a device when the default is not the right one.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

export const SAMPLE_RATE = 16000;

interface RecorderSpec {
  command: string;
  /** Arguments that write raw s16le mono 16 kHz PCM to stdout. `device` is PAXA_MIC or undefined. */
  args: (device: string | undefined) => string[] | null;
}

const FFMPEG_OUT = ["-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"];
const FFMPEG_IN = ["-hide_banner", "-loglevel", "error", "-nostdin"];

const RECORDERS: Partial<Record<NodeJS.Platform, RecorderSpec[]>> = {
  darwin: [
    {
      command: "ffmpeg",
      // ":default" is the system input device; ":<name>" picks another.
      args: (device) => [...FFMPEG_IN, "-f", "avfoundation", "-i", `:${device ?? "default"}`, ...FFMPEG_OUT],
    },
    { command: "rec", args: () => ["-q", "-t", "raw", "-r", String(SAMPLE_RATE), "-e", "signed", "-b", "16", "-c", "1", "-"] },
  ],
  linux: [
    { command: "ffmpeg", args: (device) => [...FFMPEG_IN, "-f", "pulse", "-i", device ?? "default", ...FFMPEG_OUT] },
    { command: "rec", args: () => ["-q", "-t", "raw", "-r", String(SAMPLE_RATE), "-e", "signed", "-b", "16", "-c", "1", "-"] },
    {
      command: "parecord",
      args: (device) => ["--raw", "--format=s16le", `--rate=${SAMPLE_RATE}`, "--channels=1", ...(device ? [`--device=${device}`] : [])],
    },
    {
      command: "arecord",
      args: (device) => ["-q", "-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", "1", "-t", "raw", ...(device ? ["-D", device] : [])],
    },
  ],
  win32: [
    { command: "rec", args: () => ["-q", "-t", "raw", "-r", String(SAMPLE_RATE), "-e", "signed", "-b", "16", "-c", "1", "-"] },
    {
      command: "ffmpeg",
      // DirectShow needs a device name; there is no "default" alias, so PAXA_MIC is required here.
      args: (device) => (device ? [...FFMPEG_IN, "-f", "dshow", "-i", `audio=${device}`, ...FFMPEG_OUT] : null),
    },
  ],
};

let cachedRecorder: RecorderSpec | null | undefined;

function commandExists(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

export function findRecorder(): RecorderSpec | null {
  if (cachedRecorder === undefined) {
    const specs = RECORDERS[process.platform] ?? RECORDERS.linux ?? [];
    cachedRecorder = specs.find((spec) => commandExists(spec.command)) ?? null;
  }
  return cachedRecorder;
}

export function noRecorderMessage(): string {
  switch (process.platform) {
    case "darwin":
      return "No microphone recorder found. Install ffmpeg (brew install ffmpeg) or sox (brew install sox); macOS ships none.";
    case "win32":
      return "No microphone recorder found. Install sox (its rec command), or ffmpeg with PAXA_MIC set to the DirectShow device name.";
    default:
      return "No microphone recorder found. Install ffmpeg, sox, pulseaudio-utils (parecord), or alsa-utils (arecord).";
  }
}

export interface Recording {
  command: string;
  /** Raw s16le mono 16 kHz PCM. */
  audio: Readable;
  /** Resolves with the recorder's stderr once it has exited. */
  exited: Promise<string>;
  stop(): void;
}

const activeChildren = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of activeChildren) child.kill("SIGKILL");
});

/** Start capturing the microphone. Returns null when no recorder is installed, or when the one found needs PAXA_MIC. */
export function startRecording(device: string | undefined): Recording | null {
  const spec = findRecorder();
  if (!spec) return null;
  const args = spec.args(device);
  if (!args) return null;
  const child = spawn(spec.command, args, { stdio: ["ignore", "pipe", "pipe"] });
  activeChildren.add(child);
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    if (stderr.length < 4096) stderr += d.toString();
  });
  const exited = new Promise<string>((resolve) => {
    child.on("error", (err) => {
      activeChildren.delete(child);
      resolve(`Failed to start ${spec.command}: ${err.message}`);
    });
    child.on("exit", () => {
      activeChildren.delete(child);
      resolve(stderr.trim());
    });
  });
  return {
    command: spec.command,
    audio: child.stdout as Readable,
    exited,
    stop() {
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
    },
  };
}
