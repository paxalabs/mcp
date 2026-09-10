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
  text: "Paxa Labs text to speech, saved to a file without playback.",
  voice: "khanomkrok",
});
const savedPath = tts.body.match(/to (\/\S+)/)?.[1];

// Round trip: transcribe the file just synthesized, with every output format (about 0.5 credits)
if (savedPath) {
  const stt = await call(
    "transcribe_audio",
    { file_path: savedPath, save: ["txt", "json", "srt", "vtt"], timestamps: true, vocabulary: ["Paxa Labs"] },
    300_000,
  );
  if (!/speech/i.test(stt.body)) console.log("WARNING: transcript does not contain the word 'speech'");
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

// Translation
await call("translate_to_thai", {
  text: "Welcome to our store. Free shipping on orders over 500 baht.",
  formality: "formal",
  glossary: [{ source: "free shipping", target: "ส่งฟรี" }],
}, 300_000);

// OCR (set TEST_OCR_FILE to a local PDF or image; costs 6.5 credits per page)
if (process.env.TEST_OCR_FILE) {
  await call("ocr_document", { file_path: process.env.TEST_OCR_FILE }, 300_000);
}

// Error paths: bad voice, missing file
await call("speak", { text: "test", voice: "not-a-real-voice" });
await call("ocr_document", { file_path: "/tmp/does-not-exist.pdf" });
await call("transcribe_audio", { file_path: "/tmp/does-not-exist.mp3" });

await call("get_account", {});
await client.close();
console.log("\nE2E COMPLETE");
