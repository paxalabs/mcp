import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OUT_DIR = process.env.TEST_OUT_DIR;
const KEY = process.env.PAXA_API_KEY;
if (!OUT_DIR || !KEY) throw new Error("TEST_OUT_DIR and PAXA_API_KEY are required");

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  cwd: new URL("..", import.meta.url).pathname,
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    PAXA_API_KEY: KEY,
    PAXA_OUTPUT_DIR: OUT_DIR,
    PAXA_VOCABULARY: "Paxa Labs",
  },
  stderr: "pipe",
});
const client = new Client({ name: "e2e-test", version: "0.0.0" });
await client.connect(transport);
transport.stderr?.on("data", (d) => console.error("[server stderr]", d.toString()));

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).sort().join(", "));

async function call(name, args, timeout = 60_000) {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const body = (res.content ?? []).map((c) => c.text).join("\n");
  console.log(`\n=== ${name}${res.isError ? " [ERROR]" : ""} (${Date.now() - started}ms) ===`);
  console.log(body.length > 900 ? body.slice(0, 900) + `\n... [${body.length} chars total]` : body);
  return { res, body };
}

// Free discovery tools
await call("get_account", {});
await call("list_models", {});
await call("list_voices", {});

// File-only synthesis
const tts = await call("text_to_speech", {
  text: "Paxa Labs text to speech, saved to a file without playback. Code AB2039.",
  voice: "khanomkrok",
  language: "en",
  subtitles: "srt",
  speed: 1.1,
});
if (!/Captions: .*\.srt \(\d+ cues/.test(tts.body)) console.log("WARNING: no caption file reported");
if (!/model paxa-tts-flash-v2/.test(tts.body)) console.log("WARNING: default model is not v2");
// The legacy model on request, with a voice only it carries (about 0.2 credits)
const v1 = await call("text_to_speech", { text: "Legacy model check.", voice: "donut", model: "paxa-tts-flash-v1" });
if (!/model paxa-tts-flash-v1/.test(v1.body)) console.log("WARNING: explicit v1 model not honored");
// v1 refuses a temperature: the validation error names the field
const v1Temp = await call("text_to_speech", { text: "x", voice: "donut", model: "paxa-tts-flash-v1", temperature: 1 });
if (!/body\.temperature/.test(v1Temp.body)) console.log("WARNING: the validation error did not name the field");
// Raw pcm at 16 kHz with a pause tag and temperature 0 (about 0.5 credits)
const pcm = await call("text_to_speech", { text: "Raw samples [pause 300ms] for a voice agent.", format: "pcm", sample_rate: 16000, temperature: 0 });
if (!/pcm \(16-bit little-endian mono at 16000 Hz/.test(pcm.body)) console.log("WARNING: pcm output not reported");
// Mandarin with captions: one span per character comes back, cues must fit 32 columns (about 0.5 credits)
const zh = await call("text_to_speech", {
  text: "你好，欢迎使用帕萨实验室的语音服务。今天天气很好，我们一起去公园散步吧。",
  language: "zh",
  subtitles: "srt",
});
const zhPath = zh.body.match(/to (\/\S+)/)?.[1];
if (zhPath) {
  const { readFileSync } = await import("node:fs");
  const srt = readFileSync(zhPath.replace(/\.mp3$/, ".srt"), "utf8");
  const { visibleWidth } = await import("../dist/captions.js");
  const long = srt.split("\n").filter((l) => !/^\d+$|-->|^$/.test(l) && visibleWidth(l) > 32);
  if (long.length > 0) console.log("WARNING: Chinese caption lines over 32 columns:", long);
  if (/[\u4E00-\u9FFF] [\u4E00-\u9FFF]/.test(srt)) console.log("WARNING: spaces between Chinese characters in captions");
} else console.log("WARNING: no Mandarin file reported");
// A two-voice dialogue with line timings and captions (about 1.5 credits)
const dialogue = await call("dialogue_to_speech", {
  lines: [
    { text: "Welcome back to the show. Today we talk about voices.", voice: "foithong" },
    { text: "Thanks for having me! I have been looking forward to this.", voice: "massaman" },
  ],
  gap_ms: 400,
  subtitles: "srt",
});
if (!/2 lines in 2 voices/.test(dialogue.body)) console.log("WARNING: the dialogue was not reported as 2 lines in 2 voices");
if (!/^2\. massaman: [\d.]+ to [\d.]+$/m.test(dialogue.body)) console.log("WARNING: no timing for the dialogue's second line");
const dialoguePath = dialogue.body.match(/to (\/\S+)/)?.[1];
const savedPath = tts.body.match(/to (\/\S+)/)?.[1];

// Round trip: transcribe the file just synthesized, with every output format (about 0.5 credits)
if (savedPath) {
  const stt = await call(
    "transcribe_audio",
    { file_path: savedPath, save: ["txt", "json", "srt", "vtt"], timestamps: true, vocabulary: ["text to speech"] },
    300_000,
  );
  if (!/speech/i.test(stt.body)) console.log("WARNING: transcript does not contain the word 'speech'");
  if (!/1 from config/.test(stt.body)) console.log("WARNING: the configured vocabulary was not pinned");
  // Transcribe the same clip wrapped in a video container, with a pause list (needs ffmpeg; about 0.5 credits)
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0) {
    const video = savedPath.replace(/\.mp3$/, ".mp4");
    const made = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=160x120:r=5", "-i", savedPath, "-shortest", "-c:v", "libx264", "-c:a", "aac", video]);
    if (made.status === 0) {
      const v = await call("transcribe_audio", { file_path: video, pauses_over: 0.5 }, 300_000);
      if (!/Pauses of 0\.5 s or more: \d+/.test(v.body)) console.log("WARNING: no pause list in the video transcription");
    } else console.log("WARNING: could not build the test video");
  } else console.log("(ffmpeg not installed: video transcription step skipped)");
  // Mandarin transcription of the clip synthesized above (about 0.2 credits)
  if (zhPath) {
    const zhStt = await call("transcribe_audio", { file_path: zhPath, language: "zh", save: ["srt"] }, 300_000);
    if (!/天气/.test(zhStt.body)) console.log("WARNING: the Mandarin transcript does not contain 天气");
  }
  // Speaker labels on the dialogue (about 1.5 credits)
  if (dialoguePath) {
    const d = await call("transcribe_audio", { file_path: dialoguePath, language: "en", diarization: true }, 300_000);
    if (!/Speaker 1:/.test(d.body) || !/Speaker 2:/.test(d.body)) console.log("WARNING: the dialogue did not come back as two speakers");
  }
  // Rate that transcription good through the feedback endpoint (free)
  const rid = stt.body.match(/Request id: (\S+?)\.?(\s|$)/)?.[1];
  if (rid) await call("send_feedback", { kind: "model", rating: "good", request_ids: [rid], message: "e2e: automated rating from the MCP server's end-to-end test" });
  else console.log("WARNING: no request id in the transcription result");
}

// speak: blocking, plays out loud
await call("speak", { text: "สวัสดีค่ะ ระบบเสียงของ Paxa พร้อมใช้งานแล้วค่ะ" }, 120_000);

// Queue two segments, exercise status, pause, resume, skip
await call("queue_speech", { text: "โมเดลเสียงของเราพูดภาษาไทยได้อย่างเป็นธรรมชาติ เหมาะสำหรับการอ่านหนังสือเสียง" });
await call("queue_speech", { text: "And it reads English just as comfortably, switching between languages without missing a beat." });
await call("control_playback", { action: "status" });
await new Promise((r) => setTimeout(r, 2500));
await call("control_playback", { action: "pause" });
await call("control_playback", { action: "status" });
await new Promise((r) => setTimeout(r, 1500));
await call("control_playback", { action: "resume" });
await new Promise((r) => setTimeout(r, 1500));
await call("control_playback", { action: "skip" });

// Wait for the queue to drain
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  const { body } = await call("control_playback", { action: "status" });
  if (body.includes('"state": "idle"')) break;
}

// Replay the saved file through play_audio
if (savedPath) await call("play_audio", { file_path: savedPath }, 120_000);

// Translation: into Thai with a glossary, then Thai into Japanese with two renderings and a style example
const toThai = await call("translate", {
  text: "Welcome to our store. Free shipping on orders over 500 baht.",
  target: "th",
  formality: "formal",
  glossary: [{ source: "free shipping", target: "ส่งฟรี" }, { source: "gift card", target: "บัตรของขวัญ" }],
}, 300_000);
if (!/1 of 2 glossary terms/.test(toThai.body)) console.log("WARNING: glossary usage not reported");
const toJapanese = await call("translate", {
  text: "ยินดีต้อนรับสู่ร้านของเรา",
  target: "ja",
  alternatives: 2,
  examples: [{ source: "ขอบคุณที่ใช้บริการ", target: "ご利用いただきありがとうございます。" }],
}, 300_000);
if (!/alternative 2:/.test(toJapanese.body)) console.log("WARNING: no alternative rendering shown");
const same = await call("translate", { text: "hello", target: "en", source: "en" });
if (!/unsupported_language/.test(same.body)) console.log("WARNING: a source equal to the target was not refused");

// OCR (set TEST_OCR_FILE to a local PDF or image; costs 6.5 credits per page)
if (process.env.TEST_OCR_FILE) {
  await call("ocr_document", { file_path: process.env.TEST_OCR_FILE }, 300_000);
  // Extraction on the same file with a generic schema (13 credits per page)
  await call(
    "extract_fields",
    {
      file_path: process.env.TEST_OCR_FILE,
      schema: {
        fields: {
          title: { type: "string", description: "The document's title or main heading" },
          date: { type: "date", description: "The main date printed on the document" },
        },
      },
    },
    600_000,
  );
}

// Voice design (opt in with TEST_VOICE_DESIGN=1: 10 credits, plays three lines, and needs one free voice slot,
// which it frees again): design, refine, save the FIRST draft (earlier drafts stay usable after a refine), list,
// speak in the voice, rename, delete.
if (process.env.TEST_VOICE_DESIGN) {
  const first = await call(
    "design_voice",
    { description: "A friendly barista in her twenties in Melbourne, upbeat and quick, speaking English" },
    300_000,
  );
  const handle = first.body.match(/Designed (draft-\d+)/)?.[1];
  if (!handle) console.log("WARNING: design_voice printed no draft handle");
  else {
    const second = await call("refine_voice", { draft: handle, instruction: "a little lower and calmer" }, 300_000);
    const refined = second.body.match(/into (draft-\d+)/)?.[1];
    if (!refined) console.log("WARNING: the refined design printed no draft handle");
    const saved = await call("save_voice", { draft: handle });
    const id = saved.body.match(/Saved (voice_\w+)/)?.[1];
    if (!id) console.log("WARNING: save_voice reported no id");
    else {
      const again = await call("save_voice", { draft: handle });
      if (!again.body.includes(id)) console.log("WARNING: saving the same draft again made a different voice");
      const listed = await call("list_voices", {});
      if (!listed.body.includes(id)) console.log("WARNING: list_voices does not show the saved voice");
      await call("speak", { text: "Your flat white is ready. Have a lovely morning.", voice: id }, 120_000);
      await call("rename_voice", { id, name: "E2E barista" });
      await call("delete_voice", { id });
      const gone = await call("speak", { text: "Gone.", voice: id });
      if (!gone.res.isError) console.log("WARNING: a deleted voice still spoke");
    }
  }
}

// Error paths: bad voice, missing file, a draft that does not open, deleting a catalog voice
await call("speak", { text: "test", voice: "not-a-real-voice" });
await call("save_voice", { draft: "not-a-real-draft" });
await call("delete_voice", { id: "foithong" });
await call("ocr_document", { file_path: "/tmp/does-not-exist.pdf" });
await call("transcribe_audio", { file_path: "/tmp/does-not-exist.mp3" });
await call("extract_fields", { file_path: "/tmp/does-not-exist.pdf", schema: { fields: { x: { type: "string" } } } });

await call("get_account", {});
await client.close();
console.log("\nE2E COMPLETE");
