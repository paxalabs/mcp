// Local audio plumbing on top of ffmpeg, for the parts of content work an
// API cannot do: pull the sound track out of a video, measure a file, and
// join synthesized parts into one file. ffmpeg is optional for the server as
// a whole; the tools that need it say so when it is missing.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

let cachedFfmpeg: boolean | undefined;
let cachedFfprobe: boolean | undefined;

function commandExists(command: string): boolean {
  const probe = process.platform === "win32" ? "where" : "which";
  return spawnSync(probe, [command], { stdio: "ignore" }).status === 0;
}

export function hasFfmpeg(): boolean {
  if (cachedFfmpeg === undefined) cachedFfmpeg = commandExists("ffmpeg");
  return cachedFfmpeg;
}

export function hasFfprobe(): boolean {
  if (cachedFfprobe === undefined) cachedFfprobe = commandExists("ffprobe");
  return cachedFfprobe;
}

export const FFMPEG_INSTALL_HINT =
  process.platform === "darwin"
    ? "Install ffmpeg with: brew install ffmpeg"
    : process.platform === "win32"
      ? "Install ffmpeg and make sure ffmpeg and ffprobe are on PATH."
      : "Install ffmpeg (for example: sudo apt install ffmpeg).";

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < 4096) stderr += d.toString();
    });
    child.on("error", (err) => reject(new Error(`Could not start ${command}: ${err.message}`)));
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (exit ${code ?? "signal"}): ${stderr.trim().split("\n").pop() ?? "no error output"}`));
    });
  });
}

/** Extract the sound track of a video as mono Opus in an Ogg container, which carries an hour of speech well under the API's size limit. */
export function extractAudio(video: string, output: string): Promise<void> {
  return run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-f", "ogg", output]);
}

/** Duration in seconds, read from the container. */
export function probeDuration(file: string): number {
  const res = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" });
  const value = Number.parseFloat((res.stdout ?? "").trim());
  if (res.status !== 0 || !Number.isFinite(value)) throw new Error(`ffprobe could not read the duration of ${file}: ${(res.stderr ?? "").trim()}`);
  return value;
}

/** Join audio parts in order into one file. mp3 and wav are copied; opus is re-encoded because Ogg streams cannot be spliced. */
export function concatAudio(parts: string[], output: string, format: "mp3" | "opus" | "wav", listFile: string): Promise<void> {
  writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const codec = format === "opus" ? ["-c:a", "libopus", "-b:a", "64k"] : ["-c", "copy"];
  return run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "concat", "-safe", "0", "-i", listFile, ...codec, output]);
}
