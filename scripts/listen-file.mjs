// Feed an audio file through the listen session as if it were the microphone:
//   PAXA_API_KEY=pxa_... node scripts/listen-file.mjs recording.mp3 [language]
// Decodes with ffmpeg, paces the PCM in real time with a second of silence
// before and after, and prints the transcript the realtime API returns.
// Spends 12.5 credits per minute of audio. Needs ffmpeg and Node 22.
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";

import { listenOnce } from "../dist/listen.js";

const [file, language] = process.argv.slice(2);
if (!file || !process.env.PAXA_API_KEY) {
  console.error("usage: PAXA_API_KEY=pxa_... node scripts/listen-file.mjs <audio file> [language]");
  process.exit(64);
}
const decoded = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], {
  maxBuffer: 1 << 30,
});
if (decoded.status !== 0) {
  console.error(`ffmpeg could not decode ${file}: ${decoded.stderr}`);
  process.exit(1);
}
const silence = Buffer.alloc(32000);
const all = Buffer.concat([silence, decoded.stdout, silence, silence]);
const source = new Readable({ read() {} });
let offset = 0;
const pacer = setInterval(() => {
  if (offset >= all.length) {
    clearInterval(pacer);
    source.push(null);
    return;
  }
  source.push(all.subarray(offset, offset + 640));
  offset += 640;
}, 20);

try {
  const result = await listenOnce({
    baseUrl: (process.env.PAXA_BASE_URL ?? "https://api.paxalabs.com").replace(/\/+$/, ""),
    apiKey: process.env.PAXA_API_KEY,
    language,
    maxSeconds: 300,
    waitSeconds: 60,
    device: undefined,
    isSpeaking: () => false,
    source,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  clearInterval(pacer);
}
