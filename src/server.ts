import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  OCR_MAX_BYTES,
  STT_MAX_BYTES,
  type SttRequest,
  type SttResponse,
  PaxaApiError,
  PaxaClient,
  TTS_MAX_CHARS,
  type AudioFormat,
  type TranslateRequest,
} from "./api.js";
import { chunkText } from "./chunk.js";
import { MISSING_KEY_MESSAGE, type Config } from "./config.js";
import { SpeechEngine } from "./queue.js";

const TTS_CREDITS_PER_1K = 15;

/** Single source of truth for the version the server reports: package.json. */
const PACKAGE_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const ICON_URL = "https://raw.githubusercontent.com/paxalabs/mcp/main/assets/icon.png";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".opus", ".ogg", ".flac", ".m4a", ".aac", ".aiff", ".caf"]);
const OCR_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);
const STT_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".webm"]);
const STT_CREDITS_PER_MINUTE = 8.33;
/** Inline transcripts longer than this are cut, with a pointer to the saved file. An hour of speech is well under it. */
const INLINE_TRANSCRIPT_LIMIT = 200_000;

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

function failure(err: unknown): CallToolResult {
  const body =
    err instanceof PaxaApiError ? err.display() : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: body }], isError: true };
}

/** The first free name among stem.ext, stem-2.ext, stem-3.ext: this server never overwrites a file. */
async function unusedPath(dir: string, stem: string, ext: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = join(dir, n === 1 ? `${stem}${ext}` : `${stem}-${n}${ext}`);
    if (!(await stat(candidate).catch(() => null))) return candidate;
  }
}

/** SRT and WebVTT share their cues; VTT adds a signature line and writes a period before the milliseconds. */
function srtToVtt(srt: string): string {
  return "WEBVTT\n\n" + srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
}

/** The transcript as prose, or one line per speaker turn when the recording was diarized. */
function transcriptText(response: SttResponse, diarized: boolean): string {
  if (diarized && response.segments && response.segments.length > 0) {
    return response.segments.map((seg) => `Speaker ${(seg.speaker ?? 0) + 1}: ${seg.text.trim()}`).join("\n");
  }
  return response.text.trim();
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

function estimateTtsCredits(chars: number): number {
  return Math.max(0.1, (chars * TTS_CREDITS_PER_1K) / 1000);
}

/** Shared guidance on choosing a voice; a hint, since some users prefer Thai-accented English. */
export const VOICE_GUIDANCE =
  "English text usually sounds best with one of the English voices (donut, cookie, toast, latte); " +
  "some users prefer Thai-accented English, so follow the user's preference when they have one.";

function voiceHint(config: Config): string {
  return `Voice id from list_voices (default "${config.defaultVoice}", a Thai voice). ${VOICE_GUIDANCE}`;
}

function timestampName(voice: string, format: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `paxa-tts-${stamp}-${voice}.${format}`;
}

export function createServer(config: Config, client: PaxaClient, engine: SpeechEngine): McpServer {
  const keyWarning = config.apiKey
    ? ""
    : ` WARNING: ${MISSING_KEY_MESSAGE} Until then every tool that calls the API fails with ` +
      "that message; control_playback and play_audio still work.";
  const server = new McpServer(
    {
      name: "paxalabs",
      title: "Paxa Labs",
      version: PACKAGE_VERSION,
      websiteUrl: "https://paxalabs.com/docs",
      icons: [{ src: ICON_URL, mimeType: "image/png", sizes: ["512x512"] }],
    },
    {
      instructions:
        "Paxa Labs API server (Thai and English speech AI). speak plays a short line out loud on " +
        "this machine; queue_speech reads long content aloud continuously; control_playback inspects and " +
        "controls the shared audio queue; text_to_speech writes an audio file without playing it; " +
        "play_audio replays a local audio file; translate_to_thai translates any language into " +
        "Thai; ocr_document runs OCR on a local PDF or image; transcribe_audio turns a local " +
        "recording into text and subtitles. Paid tools spend account credits " +
        "(check with get_account)." +
        keyWarning,
    },
  );

  server.registerTool(
    "speak",
    {
      title: "Speak out loud",
      annotations: { title: "Speak out loud", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        "Synthesize a short line with Paxa TTS and play it through this machine's speakers. " +
        "Blocks until playback finishes. Waits for the currently playing audio but jumps ahead " +
        "of queued long-form segments. For long content use queue_speech. " +
        `Costs ${TTS_CREDITS_PER_1K} credits per 1000 characters.`,
      inputSchema: {
        text: z.string().min(1).max(2000).describe("Text to speak, Thai or English, up to 2000 characters"),
        voice: z.string().optional().describe(voiceHint(config)),
      },
    },
    async ({ text: input, voice }) => {
      try {
        const [segment] = engine.enqueueTts([input], voice ?? config.defaultVoice, true);
        const settled = await engine.waitFor(segment as NonNullable<typeof segment>);
        switch (settled.status) {
          case "done":
            return text(
              `Spoke ${input.length} characters with voice "${settled.voice}"` +
                (settled.delivery === "streamed" ? " (streamed)" : "") +
                `. Audio file: ${settled.file}`,
            );
          case "skipped":
            return text("Playback was skipped before it finished.");
          case "cleared":
            return text("Playback was cleared before it finished.");
          default:
            return failure(settled.error ?? "Playback failed for an unknown reason.");
        }
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "queue_speech",
    {
      title: "Queue long-form speech",
      annotations: { title: "Queue long-form speech", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        "Read long content aloud (stories, articles, books). Splits the text into segments, " +
        "synthesizes ahead while playing, and returns immediately; segments play in order " +
        "after anything already queued. Monitor and control with the control_playback tool. " +
        `Costs ${TTS_CREDITS_PER_1K} credits per 1000 characters.`,
      inputSchema: {
        text: z.string().min(1).max(200_000).describe("Text to read aloud, Thai or English"),
        voice: z.string().optional().describe(voiceHint(config)),
      },
    },
    async ({ text: input, voice }) => {
      try {
        const chunks = chunkText(input);
        if (chunks.length === 0) return failure("The text contains nothing to read.");
        const segments = engine.enqueueTts(chunks, voice ?? config.defaultVoice, false);
        const chars = chunks.reduce((sum, c) => sum + c.length, 0);
        const credits = (chars * TTS_CREDITS_PER_1K) / 1000;
        return text(
          `Queued ${segments.length} segment(s), ${chars} characters, about ${credits.toFixed(1)} credits. ` +
            `Playback starts as soon as the first segment is synthesized. ` +
            `Use control_playback with action "status" to monitor.`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "control_playback",
    {
      title: "Playback control",
      annotations: { title: "Playback control", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Inspect and control the shared audio queue. status reports what is playing, what is " +
        "queued, and any synthesis failures. pause and resume halt and continue playback " +
        "(not supported on Windows). skip drops the current segment. clear stops playback " +
        "and empties the queue.",
      inputSchema: {
        action: z.enum(["status", "pause", "resume", "skip", "clear"]),
      },
    },
    async ({ action }) => {
      try {
        switch (action) {
          case "status":
            return text(JSON.stringify(engine.status(), null, 2));
          case "pause": {
            const r = engine.pause();
            return r.changed ? text("Paused.") : failure(r.reason ?? "Could not pause.");
          }
          case "resume": {
            const r = engine.resume();
            return r.changed ? text("Resumed.") : failure(r.reason ?? "Could not resume.");
          }
          case "skip": {
            const r = engine.skip();
            return r.changed ? text("Skipped the current segment.") : failure(r.reason ?? "Could not skip.");
          }
          case "clear": {
            const r = engine.clear();
            return text(
              `Cleared ${r.clearedPending} pending segment(s)` +
                (r.clearedCurrent ? " and stopped the current one." : "."),
            );
          }
        }
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "play_audio",
    {
      title: "Play an audio file",
      annotations: { title: "Play an audio file", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      description:
        "Play a local audio file through this machine's speakers, for example a file produced " +
        "earlier by text_to_speech. Blocks until playback finishes. Free (no API call).",
      inputSchema: {
        file_path: z.string().describe("Path to a local audio file (mp3, wav, opus, ogg, flac, m4a, aac)"),
      },
    },
    async ({ file_path }) => {
      try {
        const path = resolve(file_path);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) return failure(`No file found at ${path}`);
        if (!AUDIO_EXTENSIONS.has(extname(path).toLowerCase())) {
          return failure(`${path} does not look like an audio file.`);
        }
        const settled = await engine.waitFor(engine.enqueueFile(path));
        switch (settled.status) {
          case "done":
            return text(`Finished playing ${path}`);
          case "skipped":
            return text("Playback was skipped before it finished.");
          case "cleared":
            return text("Playback was cleared before it finished.");
          default:
            return failure(settled.error ?? "Playback failed for an unknown reason.");
        }
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "text_to_speech",
    {
      title: "Text to speech (file only)",
      annotations: { title: "Text to speech (file only)", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        "Synthesize speech with Paxa TTS and save it as an audio file without playing it. " +
        `Costs ${TTS_CREDITS_PER_1K} credits per 1000 characters.`,
      inputSchema: {
        text: z.string().min(1).max(TTS_MAX_CHARS).describe(`Text to synthesize, up to ${TTS_MAX_CHARS} characters`),
        voice: z.string().optional().describe(voiceHint(config)),
        format: z.enum(["mp3", "opus", "wav"]).optional().describe('Audio format (default "mp3")'),
        output_path: z
          .string()
          .optional()
          .describe("Where to save the file. Relative paths resolve against PAXA_OUTPUT_DIR (or the working directory)."),
      },
    },
    async ({ text: input, voice, format, output_path }) => {
      try {
        const chosenVoice = voice ?? config.defaultVoice;
        const chosenFormat: AudioFormat = format ?? "mp3";
        const audio = await client.tts({ text: input, voice: chosenVoice, format: chosenFormat });
        const target = output_path
          ? isAbsolute(output_path)
            ? output_path
            : join(config.outputDir, output_path)
          : join(config.outputDir, timestampName(chosenVoice, chosenFormat));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, audio);
        const credits = estimateTtsCredits(input.length);
        return text(
          `Saved ${(audio.length / 1024).toFixed(1)} KiB of ${chosenFormat} audio to ${target} ` +
            `(voice "${chosenVoice}", ${input.length} characters, about ${credits.toFixed(1)} credits).`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "translate_to_thai",
    {
      title: "Translate to Thai",
      annotations: { title: "Translate to Thai", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Translate text from any language into Thai with Paxa Translate. Accepts a single " +
        "string or up to 200 segments that share context. Costs 25 credits per 1000 text " +
        "characters (minimum 2 credits); context and glossary characters bill at 8 per 1000.",
      inputSchema: {
        text: z
          .union([z.string().min(1).max(20_000), z.array(z.string().min(1)).min(1).max(200)])
          .describe("Text to translate: one string, or an array of segments translated together"),
        formality: z.enum(["auto", "formal", "casual"]).optional(),
        borrowed_words: z
          .enum(["auto", "transliterate", "preserve"])
          .optional()
          .describe("How to render foreign loanwords: transliterate into Thai script, or preserve as-is"),
        format: z.enum(["text", "markdown", "html"]).optional().describe("Treat input as plain text, Markdown, or HTML"),
        instructions: z.string().max(4000).optional().describe("Free-form guidance for the translator"),
        context: z
          .string()
          .max(100_000)
          .optional()
          .describe("Background material that improves accuracy, billed at the lower reference rate"),
        do_not_translate: z.array(z.string()).max(100).optional().describe("Strings preserved verbatim"),
        glossary: z
          .array(z.object({ source: z.string(), target: z.string() }))
          .max(5000)
          .optional()
          .describe("Term pairs applied contextually"),
      },
    },
    async ({ text: input, ...options }) => {
      try {
        const request: TranslateRequest = { text: input };
        if (options.formality) request.formality = options.formality;
        if (options.borrowed_words) request.borrowed_words = options.borrowed_words;
        if (options.format) request.format = options.format;
        if (options.instructions) request.instructions = options.instructions;
        if (options.context) request.context = options.context;
        if (options.do_not_translate) request.do_not_translate = options.do_not_translate;
        if (options.glossary) request.glossary = options.glossary;

        const response = await client.translate(request);
        const lines = response.translations.map((t, i) => {
          const head = response.translations.length > 1 ? `[${i + 1}] ` : "";
          const source = t.detected_source ? ` (detected source: ${t.detected_source})` : "";
          const review = t.review ? `\n${head}review flag: ${t.review.reason}${t.review.detail ? `, ${t.review.detail}` : ""}` : "";
          return `${head}${t.text}${source}${review}`;
        });
        lines.push(`\nUsed ${response.usage.credits} credits (${response.usage.billable_chars} billable characters).`);
        return text(lines.join("\n"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "ocr_document",
    {
      title: "OCR a document",
      annotations: { title: "OCR a document", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Run Paxa OCR on a local PDF, PNG, JPEG, or WebP file and return its content as " +
        "GitHub-flavored Markdown (or structured blocks). Up to 50 pages and 10 MiB per file. " +
        "Costs 6.5 credits per page.",
      inputSchema: {
        file_path: z.string().describe("Path to a local PDF, PNG, JPEG, or WebP file"),
        output: z
          .enum(["markdown", "structured"])
          .optional()
          .describe('"markdown" (default) returns prose; "structured" returns typed blocks as JSON'),
      },
    },
    async ({ file_path, output }) => {
      try {
        const path = resolve(file_path);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) return failure(`No file found at ${path}`);
        if (info.size > OCR_MAX_BYTES) {
          return failure(
            `${path} is ${(info.size / 1024 / 1024).toFixed(1)} MiB; the OCR limit is 10 MiB per file.`,
          );
        }
        const ext = extname(path).toLowerCase();
        if (ext && !OCR_EXTENSIONS.has(ext)) {
          return failure(`${path} is not a supported document type (PDF, PNG, JPEG, WebP).`);
        }

        const document = (await readFile(path)).toString("base64");
        const response = await client.ocr({ document, output: output ?? "markdown" });
        const usage = `Read ${response.usage.pages} page(s) for ${response.usage.credits} credits.`;

        if ((output ?? "markdown") === "structured") {
          return text(`${usage}\n\n${JSON.stringify(response.pages, null, 2)}`);
        }
        const body = response.pages
          .map((p) => (response.pages.length > 1 ? `[page ${p.page}]\n\n${p.markdown ?? ""}` : (p.markdown ?? "")))
          .join("\n\n");
        return text(`${usage}\n\n${body}`);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "transcribe_audio",
    {
      title: "Transcribe a recording",
      annotations: { title: "Transcribe a recording", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        "Transcribe a local recording of Thai or English speech (mp3, wav, flac, ogg, m4a, aac, or webm; " +
        "up to 60 minutes and 25 MiB) with Paxa STT. The transcript comes back inline, so nothing needs " +
        "to be read from disk afterwards; optionally it is also saved as txt, json (with word timings " +
        "and segments), srt, or vtt, named after the recording. Existing files are never overwritten. " +
        "Detects the language, handles code-switching, and can label speakers. Costs " +
        `${STT_CREDITS_PER_MINUTE} credits per minute of audio (0.1 minimum); subtitles and word timings ` +
        "cost nothing extra. Long recordings take minutes to process.",
      inputSchema: {
        file_path: z.string().describe("Path to a local mp3, wav, flac, ogg, m4a, aac, or webm recording"),
        language: z
          .string()
          .max(16)
          .optional()
          .describe('Language hint as a BCP 47 tag such as "th" or "en". Omit to auto-detect.'),
        diarization: z
          .boolean()
          .optional()
          .describe("Label speakers. The transcript is then returned as one line per turn, and subtitle cues never cross a speaker change."),
        style: z
          .enum(["verbatim", "clean"])
          .optional()
          .describe('"verbatim" (default) keeps fillers and false starts; "clean" drops them'),
        convention: z
          .enum(["spoken", "written"])
          .optional()
          .describe('"spoken" (default) writes numbers and dates as they were said; "written" uses numerals'),
        vocabulary: z
          .array(z.string().max(50))
          .max(50)
          .optional()
          .describe(
            "Keyword pinning: terms the recording likely contains, spelled the way they should appear in the " +
              "transcript (product names, people, places, jargon; Thai or English). Up to 50 terms of 50 characters. " +
              "They bias recognition and are never inserted.",
          ),
        timestamps: z
          .boolean()
          .optional()
          .describe("Also return word-level timings inline as JSON (can be long). The json file always has them."),
        subtitle_line_chars: z
          .number()
          .int()
          .min(10)
          .max(120)
          .optional()
          .describe("Characters per subtitle line, 10 to 120 (default 60). Thai marks above and below consonants are not counted."),
        save: z
          .array(z.enum(["txt", "json", "srt", "vtt"]))
          .optional()
          .describe(
            "Files to write, named after the recording: txt (the transcript), json (text, words with timings, segments, usage), " +
              "srt or vtt (subtitles rendered by the API). Omit to write nothing.",
          ),
        output_dir: z
          .string()
          .optional()
          .describe("Where to write the files. Defaults to the recording's own folder. A relative path resolves against PAXA_OUTPUT_DIR (or the working directory)."),
      },
    },
    async ({ file_path, language, diarization, style, convention, vocabulary, timestamps, subtitle_line_chars, save, output_dir }) => {
      try {
        const path = resolve(file_path);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) return failure(`No file found at ${path}`);
        if (info.size > STT_MAX_BYTES) {
          return failure(
            `${path} is ${(info.size / 1024 / 1024).toFixed(1)} MiB; the transcription limit is 25 MiB per file.`,
          );
        }
        const ext = extname(path).toLowerCase();
        if (ext && !STT_EXTENSIONS.has(ext)) {
          return failure(`${path} is not a supported recording type (mp3, wav, flac, ogg, m4a, aac, webm).`);
        }

        const formats = new Set(save ?? []);
        const wantSrt = formats.has("srt");
        const wantVtt = formats.has("vtt");
        const request: SttRequest = { audio: (await readFile(path)).toString("base64") };
        if (language) request.language = language;
        if (diarization) request.diarization = true;
        if (style) request.style = style;
        if (convention) request.convention = convention;
        if (vocabulary && vocabulary.length > 0) request.vocabulary = vocabulary;
        if (timestamps || formats.has("json")) request.timestamps = "word";
        // One rendered file covers both subtitle formats: VTT is derived from SRT when both are wanted.
        if (wantSrt || wantVtt) request.subtitles = wantSrt ? "srt" : "vtt";
        if (subtitle_line_chars != null) request.subtitle_line_chars = subtitle_line_chars;

        const response = await client.stt(request);
        const transcript = transcriptText(response, diarization === true);

        const written: string[] = [];
        if (formats.size > 0) {
          const dir = output_dir
            ? isAbsolute(output_dir)
              ? output_dir
              : join(config.outputDir, output_dir)
            : dirname(path);
          await mkdir(dir, { recursive: true });
          const stem = basename(path, extname(path));
          const files: Array<[string, string]> = [];
          if (formats.has("txt")) files.push([".txt", transcript + "\n"]);
          if (formats.has("json")) {
            const record = {
              text: response.text,
              words: response.words ?? [],
              segments: response.segments ?? [],
              usage: response.usage,
            };
            files.push([".json", JSON.stringify(record, null, 2) + "\n"]);
          }
          if (response.subtitles) {
            if (wantSrt) files.push([".srt", response.subtitles]);
            if (wantVtt) files.push([".vtt", wantSrt ? srtToVtt(response.subtitles) : response.subtitles]);
          }
          for (const [fileExt, body] of files) {
            const target = await unusedPath(dir, stem, fileExt);
            await writeFile(target, body, "utf8");
            written.push(target);
          }
        }

        const parts = [
          `Transcribed ${formatDuration(response.usage.seconds)} of audio for ${response.usage.credits} credits.`,
        ];
        if (written.length > 0) parts.push("Saved:\n" + written.map((f) => `- ${f}`).join("\n"));
        if (transcript.length > INLINE_TRANSCRIPT_LIMIT) {
          parts.push(transcript.slice(0, INLINE_TRANSCRIPT_LIMIT) + "\n[transcript cut here; the saved txt file has all of it]");
        } else {
          parts.push(transcript || "(no speech detected)");
        }
        if (timestamps && response.words) parts.push("Word timings:\n" + JSON.stringify(response.words));
        return text(parts.join("\n\n"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "list_voices",
    {
      title: "List voices",
      annotations: { title: "List voices", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: "List the Paxa TTS voice roster: ids, names, gender, language, and character notes. Free.",
      inputSchema: {},
    },
    async () => {
      try {
        const voices = await client.voices();
        const lines = voices.map((v) => {
          const traits = [v.name, v.gender, v.language, v.accent].filter(Boolean).join(", ");
          return `- ${v.id} (${traits}): ${v.description ?? "no description"}`;
        });
        return text(
          `${voices.length} voices. Default voice: ${config.defaultVoice}. ` +
            `Thai leads: khanomkrok (male) and nomyen (female). ${VOICE_GUIDANCE}\n${lines.join("\n")}`,
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "list_models",
    {
      title: "List models",
      annotations: { title: "List models", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: "List available Paxa models with their limits and credit pricing. Free.",
      inputSchema: {},
    },
    async () => {
      try {
        const models = await client.models();
        const lines = models.map((m) => {
          const facts: string[] = [`product: ${m.product}`];
          if (m.credits_per_1k_chars != null) facts.push(`${m.credits_per_1k_chars} credits per 1000 chars`);
          if (m.reference_credits_per_1k_chars != null) {
            facts.push(`${m.reference_credits_per_1k_chars} credits per 1000 reference chars`);
          }
          if (m.credits_per_page != null) facts.push(`${m.credits_per_page} credits per page`);
          if (m.credits_per_hour != null) {
            facts.push(`${m.credits_per_hour} credits per hour of audio (${(m.credits_per_hour / 60).toFixed(2)} per minute)`);
          }
          if (m.min_request_credits != null) facts.push(`minimum ${m.min_request_credits} credits per request`);
          if (m.max_chars != null) facts.push(`up to ${m.max_chars} chars per request`);
          if (m.max_pages != null) facts.push(`up to ${m.max_pages} pages`);
          if (m.max_duration_seconds != null) facts.push(`up to ${Math.round(m.max_duration_seconds / 60)} minutes of audio`);
          if (m.max_bytes != null) facts.push(`up to ${Math.round(m.max_bytes / 1024 / 1024)} MiB`);
          if (m.voices.length > 0) facts.push(`${m.voices.length} voices`);
          if (m.sources) facts.push(`sources: ${m.sources.join(", ")} or auto`);
          if (m.target) facts.push(`target: ${m.target}`);
          return `- ${m.id} (${m.name}): ${facts.join("; ")}`;
        });
        return text(lines.join("\n"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "get_account",
    {
      title: "Account and credits",
      annotations: { title: "Account and credits", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description: "Show the API key's account: credit balance, plan, and rate limits. Free.",
      inputSchema: {},
    },
    async () => {
      try {
        const account = await client.me();
        return text(
          [
            `Key "${account.key.name ?? account.key.key_start}" (${account.key.key_start}...), ` +
              `${account.key.credits_spent} credits spent` +
              (account.key.credit_limit != null ? `, spending cap ${account.key.credit_limit}` : ", no spending cap") +
              ".",
            `Balance: ${account.balance.total} credits (wallet ${account.balance.wallet}, plan ${account.balance.plan}).`,
            `Plan "${account.plan.key}": ${account.plan.monthly_credits} credits per month, ` +
              `${account.plan.rpm} requests per minute, ${account.plan.concurrency} concurrent requests.`,
          ].join("\n"),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}
