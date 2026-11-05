// Local audio plumbing on top of ffmpeg, for the parts of content work an
// API cannot do: pull the sound track out of a video, measure a file, and
// join synthesized parts into one file. ffmpeg is optional for the server as
// a whole; the tools that need it say so when it is missing.
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { appendFile, readFile, rm, writeFile } from "node:fs/promises";

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

/** Samples in one mp3 frame: MPEG-1 (32 kHz and up) carries 1152, MPEG-2 and 2.5 carry 576. */
function mp3FrameSamples(rate: number): number {
  return rate >= 32000 ? 1152 : 576;
}

/**
 * Seconds a part adds to a joined file. A copy join keeps every mp3 frame, so mp3 is counted in frames: the
 * container's duration is a size estimate that drifts on long files, or a gapless figure that leaves out the encoder
 * delay. Other formats read the container's duration.
 */
export function joinedSeconds(file: string): number {
  const res = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-count_packets", "-show_entries", "stream=codec_name,sample_rate,nb_read_packets", "-of", "json", file],
    { encoding: "utf8" },
  );
  const stream = (JSON.parse(res.stdout || "{}") as { streams?: Array<{ codec_name?: string; sample_rate?: string; nb_read_packets?: string }> }).streams?.[0];
  const rate = Number(stream?.sample_rate);
  const packets = Number(stream?.nb_read_packets);
  if (stream?.codec_name === "mp3" && rate > 0 && packets > 0) return (packets * mp3FrameSamples(rate)) / rate;
  return probeDuration(file);
}

/** Join audio parts in order into one file. mp3 and wav are copied; opus is re-encoded because Ogg streams cannot be spliced. */
export function concatAudio(parts: string[], output: string, format: "mp3" | "opus" | "wav", listFile: string): Promise<void> {
  writeFileSync(listFile, parts.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const codec = format === "opus" ? ["-c:a", "libopus", "-b:a", "64k"] : ["-c", "copy"];
  return run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "concat", "-safe", "0", "-i", listFile, ...codec, output]);
}

/** Join headerless sample files (pcm, mulaw, alaw) in order: with no container, appending the bytes is the whole job. */
export async function concatRaw(parts: string[], output: string): Promise<void> {
  await writeFile(output, Buffer.alloc(0));
  for (const part of parts) await appendFile(output, await readFile(part));
}

/** Silence to put between joined parts of headerless samples: pcm is 16-bit zeros, mulaw and alaw their G.711 zero code. */
export function rawSilence(format: "pcm" | "mulaw" | "alaw", sampleRate: number, ms: number): Buffer {
  if (format === "pcm") return Buffer.alloc(Math.round((sampleRate * ms) / 1000) * 2, 0);
  return Buffer.alloc(Math.round(8 * ms), format === "mulaw" ? 0xff : 0xd5);
}

/**
 * Write about `seconds` of silence in the codec, rate, and channels of `like`, so the concat demuxer can copy it
 * between parts. mp3 is a whole number of frames with no Xing header, so joinedSeconds reads exactly what it adds.
 */
export function makeSilence(like: string, seconds: number, output: string, format: "mp3" | "opus" | "wav"): Promise<void> {
  const res = spawnSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels", "-of", "csv=p=0", like], {
    encoding: "utf8",
  });
  const [rate, channels] = (res.stdout ?? "").trim().split(",").map((v) => Number.parseInt(v, 10));
  if (res.status !== 0 || !rate || !channels) throw new Error(`ffprobe could not read the format of ${like}: ${(res.stderr ?? "").trim()}`);
  const source = ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", `anullsrc=r=${rate}:cl=${channels === 1 ? "mono" : "stereo"}`];
  if (format !== "mp3") return run("ffmpeg", [...source, "-t", String(seconds), "-c:a", format === "opus" ? "libopus" : "pcm_s16le", output]);
  // The encoder adds frames of its own at the end, so encode a little more and copy out exactly the frames wanted.
  const frames = Math.max(1, Math.round((seconds * rate) / mp3FrameSamples(rate)));
  const encoded = output + ".long.mp3";
  return run("ffmpeg", [...source, "-t", String(seconds + 0.5), "-c:a", "libmp3lame", encoded])
    .then(() => run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", encoded, "-c:a", "copy", "-frames:a", String(frames), "-write_xing", "0", output]))
    .finally(() => rm(encoded, { force: true }));
}

/**
 * A streamed WAV says 0xFFFFFFFF for its sizes, because its length is known only at the end. Write the real sizes
 * into the RIFF and data headers so every player and ffprobe reads the length. Anything else is returned unchanged.
 */
export function fixWavSizes(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return wav;
  wav.writeUInt32LE(wav.length - 8, 4);
  for (let offset = 12; offset + 8 <= wav.length; ) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString("ascii", offset, offset + 4) === "data") {
      wav.writeUInt32LE(wav.length - offset - 8, offset + 4);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  return wav;
}
