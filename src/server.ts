import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { openAsBlob } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AUDIO_FORMATS,
  EXTRACT_MAX_BYTES,
  type ExtractRequest,
  OCR_MAX_BYTES,
  SAMPLE_RATES,
  STT_MAX_BYTES,
  type SttRequest,
  type SttResponse,
  PaxaApiError,
  PaxaClient,
  DIALOGUE_MAX_CHARS,
  DIALOGUE_MAX_LINES,
  TRANSLATE_LANGUAGES,
  TTS_MAX_STREAM_CHARS,
  type AudioFormat,
  type DialogueLine,
  type DialogueOutcome,
  isRawFormat,
  type RawFormat,
  type DesignedVoiceWords,
  type FeedbackRequest,
  type SampleRate,
  type SpeechOptions,
  type TtsLanguage,
  type TtsRequest,
  type TranslateLanguage,
  type TranslateRequest,
  type VoiceDesignRequest,
} from "./api.js";
import {
  type DeviceLogin,
  SIGN_IN_API,
  type StoredAuth,
  finishDeviceLogin,
  openInBrowser,
  readStoredAuth,
  startDeviceLogin,
  verifiedSignIn,
} from "./auth.js";
import { chunkText } from "./chunk.js";
import {
  TTS_MODELS,
  defaultVoiceWarning,
  isDesignedVoice,
  parseVocabulary,
  type Config,
  type TtsModel,
} from "./config.js";
import { buildCues, defaultLineChars, findPauses, markSpacing, toSrt, toVtt, type Cue, type WordSpan } from "./captions.js";
import { listenOnce, realtimeSupported } from "./listen.js";
import {
  FFMPEG_INSTALL_HINT,
  concatAudio,
  concatRaw,
  extractAudio,
  fixWavSizes,
  hasFfmpeg,
  hasFfprobe,
  joinedSeconds,
  makeSilence,
  rawSilence,
} from "./media.js";
import { SpeechEngine } from "./queue.js";
import { findRecorder, noRecorderMessage } from "./recorder.js";

const TTS_CREDITS_PER_1K = 10;
/** Speech in a designed voice bills 1.25 times; the premium adds to the timestamps one (1.5 times with both). */
const DESIGNED_VOICE_PREMIUM = 0.25;
const TIMESTAMPS_PREMIUM = 0.25;
const DESIGN_CREDITS = 5;
const TTS_DESIGNED_RATE = TTS_CREDITS_PER_1K * (1 + DESIGNED_VOICE_PREMIUM);
const TTS_TIMED_RATE = TTS_CREDITS_PER_1K * (1 + TIMESTAMPS_PREMIUM);
const TTS_DESIGNED_TIMED_RATE = TTS_CREDITS_PER_1K * (1 + DESIGNED_VOICE_PREMIUM + TIMESTAMPS_PREMIUM);
const TTS_PRICE_NOTE = `Costs ${TTS_CREDITS_PER_1K} credits per 1000 characters, ${TTS_DESIGNED_RATE} in a designed voice (voice_...).`;
const TTS_LANGUAGE_HINT =
  'How codes, digits, and symbols are read: "th", "en", or "zh". Words keep the language of their script. ' +
  'Default "auto" works it out from the text; set it when a code such as AB2039 should be spelled in a particular language.';
const SPEED_HINT =
  "Speaking rate from 0.5 to 1.5 as a multiplier on the voice's design speed (1 is as designed; 1.2 to 1.3 " +
  "suits long reads). Pitch is preserved and the price is the same. Defaults to PAXA_DEFAULT_SPEED when set.";
const STT_LANGUAGE_HINT =
  'The language the speech is expected in, as a BCP 47 tag such as "th", "en", or "zh". A hint, not a filter: other ' +
  "languages are still written as spoken. Omit to auto-detect; set it when detection picks the wrong language.";
const SUBTITLE_COLUMNS_HINT =
  "Columns per subtitle line, 10 to 120 (default 60, or 32 when the words are mostly Chinese, Japanese, or Korean). " +
  "A Chinese, Japanese, or Korean character or full-width punctuation mark takes two columns and Thai marks above " +
  "and below a consonant take none, so one figure fills about the same width in every script.";
const TEMPERATURE_HINT =
  "How much the reading (pacing, pauses, breaths, melody) varies from one request to the next, 0 to 2, rounded to " +
  "the nearest 0.1 (default 0.5). 0 gives the most repeatable reading, such as a line regenerated to match the rest of a " +
  "voiceover; higher values vary more. Read by paxa-tts-flash-v2; v1 refuses any value but 0.5. Same price.";
const EMOTION_TAG_HINT =
  "Direction tags (paxa-tts-flash-v2, every voice): words in square brackets written into the text set the delivery " +
  "from that point on, in English, Thai, or Chinese, e.g. [whispering], [speaking slowly, close to the microphone], " +
  "[sad:0.5], or a blend [happy:0.7+sad:0.3]; [neutral] returns to the voice's own delivery. Sounds such as [laughs], " +
  "[sighs], [gasps] play where written; [um] and [hmm] are spoken; <emph>...</emph> and <whisper>...</whisper> mark a " +
  "span. [short pause], [pause], and [long pause] add silence after the word before them, and [pause 300ms] an exact " +
  "length up to 500 ms. Nothing in brackets is spoken, tag characters bill as text, and a tag the model cannot do is " +
  "refused before any charge. On paxa-tts-flash-v1 only khanomchan and kaprao read tags, from a fixed emotion list, " +
  "and no voice reads pause tags.";

/** Single source of truth for the version the server reports: package.json. */
const PACKAGE_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
const ICON_URL = "https://raw.githubusercontent.com/paxalabs/mcp/main/assets/icon.png";
/** A short note to the agent about the newest tools, shown with the server instructions at connect time. */
const WHATS_NEW =
  `New in ${PACKAGE_VERSION}: the server no longer needs an API key. sign_in connects the user's Paxa account ` +
  "through their browser (the user approves on the Paxa sign-in page); the sign-in serves every session on this " +
  "machine and stays until it goes 30 days unused, and an API key in PAXA_API_KEY, when set, is used instead. " +
  "Since 0.1.0-beta.18: dialogue_to_speech writes a conversation to one audio file, each line in its own " +
  "voice, with the line timings and captions that never cross two lines; text_to_speech sends up to 20,000 " +
  "characters per request, so long scripts join fewer parts; transcribe_audio takes recordings up to 120 minutes " +
  "and 95 MiB, labels speakers across the whole length, and reads mu-law and A-law phone recordings. Since " +
  "0.1.0-beta.17: translate replaces translate_to_thai and writes any of 15 languages (target), from any of them; " +
  "transcribe_audio and listen transcribe English and Mandarin as well as Thai; ocr_document reads Simplified " +
  "Chinese pages; the speech tools take temperature and pause tags such as [pause] or [pause 300ms]; and " +
  "text_to_speech also writes raw pcm, mulaw, and alaw, with sample_rate for pcm and wav. Since 0.1.0-beta.16: " +
  `design_voice makes a new voice from a written description (${DESIGN_CREDITS} credits), refine_voice changes it, ` +
  "and save_voice keeps it under an id (voice_...) that the speech tools accept. Since 0.1.0-beta.14 speech runs on " +
  "Paxa TTS Flash v2 by default: its 50 voices each speak Thai, English, and Mandarin, and every voice reads " +
  "direction tags written into the text, such as [whispering], [laughs], [speaking slowly] or <emph>, so try them " +
  "when the delivery matters. Pass model paxa-tts-flash-v1 only for regional Thai accents or a voice v2 does not " +
  "carry. Also: transcribe_audio takes video files and lists pauses to cut, text_to_speech takes long scripts and " +
  "writes matching srt or vtt captions, speed sets the rate, listen records one spoken turn, and send_feedback " +
  "reports a wrong output against a result's request id.\n";

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".opus", ".ogg", ".flac", ".m4a", ".aac", ".aiff", ".caf"]);
const OCR_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);
const STT_EXTENSIONS = new Set([".mp3", ".wav", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".webm"]);
/** Video containers whose sound track ffmpeg pulls out locally before transcription. */
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".mkv", ".avi", ".mpg", ".mpeg", ".ts", ".3gp", ".wmv", ".flv"]);
/** The most text text_to_speech and dialogue_to_speech take in one call, split into requests and joined. */
const TTS_LONG_TEXT_MAX = 200_000;
/** dialogue_to_speech takes this many lines in one call, sent DIALOGUE_MAX_LINES at a time. */
const DIALOGUE_SCRIPT_MAX_LINES = 2000;
/** Line timings listed inline before the rest is summarized. */
const LINE_TIMINGS_INLINE = 300;
const STT_CREDITS_PER_MINUTE = 8.33;
const LISTEN_CREDITS_PER_MINUTE = 12.5;
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

const VOCABULARY_MAX_TERMS = 50;
const VOCABULARY_MAX_CHARS = 50;

interface PinnedVocabulary {
  terms: string[];
  fromCall: number;
  fromConfig: number;
  dropped: number;
}

/**
 * The vocabulary to pin on a transcription: the call's own terms first, then
 * PAXA_VOCABULARY, then PAXA_VOCABULARY_FILE (read now, so edits apply without
 * a restart), deduplicated and cut at the API's limit. A term over the length
 * limit or an unreadable file is a configuration error, reported before any
 * credits are spent.
 */
async function pinnedVocabulary(config: Config, callTerms: string[] | undefined): Promise<PinnedVocabulary> {
  const sources: Array<[string, string[]]> = [
    ["the call", callTerms ?? []],
    ["PAXA_VOCABULARY", config.vocabulary],
  ];
  if (config.vocabularyFile) {
    const path = resolve(config.vocabularyFile);
    let body: string;
    try {
      body = await readFile(path, "utf8");
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      throw new Error(`PAXA_VOCABULARY_FILE points at ${path}, which could not be read: ${why}`);
    }
    sources.push([`PAXA_VOCABULARY_FILE (${path})`, parseVocabulary(body, "\n")]);
  }

  const seen = new Set<string>();
  const result: PinnedVocabulary = { terms: [], fromCall: 0, fromConfig: 0, dropped: 0 };
  for (const [source, list] of sources) {
    for (const term of list) {
      if (term.length > VOCABULARY_MAX_CHARS) {
        throw new Error(
          `Vocabulary term "${term}" from ${source} is ${term.length} characters; the limit is ${VOCABULARY_MAX_CHARS}.`,
        );
      }
      if (seen.has(term)) continue;
      seen.add(term);
      if (result.terms.length >= VOCABULARY_MAX_TERMS) {
        result.dropped++;
        continue;
      }
      result.terms.push(term);
      if (source === "the call") result.fromCall++;
      else result.fromConfig++;
    }
  }
  return result;
}

/** How many leaves in an extraction schema are marked required, arrays counted once. Tolerant of shapes the API will refuse. */
function countRequiredFields(fields: unknown): number {
  if (!fields || typeof fields !== "object") return 0;
  let count = 0;
  for (const def of Object.values(fields as Record<string, unknown>)) {
    if (!def || typeof def !== "object") continue;
    const d = def as { type?: unknown; required?: unknown; fields?: unknown; items?: unknown };
    if (d.type === "object") count += countRequiredFields(d.fields);
    else if (d.type === "array") {
      const items = d.items as { type?: unknown; fields?: unknown; required?: unknown } | undefined;
      if (items?.type === "object") count += countRequiredFields(items.fields);
      else if (items?.required === true) count++;
    } else if (d.required === true) count++;
  }
  return count;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - minutes * 60)} s`;
}

/** Credits per 1000 characters for a speech request in this voice, with or without word timings. */
function ttsRate(voice: string, timed: boolean): number {
  return TTS_CREDITS_PER_1K * (1 + (isDesignedVoice(voice) ? DESIGNED_VOICE_PREMIUM : 0) + (timed ? TIMESTAMPS_PREMIUM : 0));
}

function estimateTtsCredits(chars: number, ratePer1k: number): number {
  return Math.max(0.1, (chars * ratePer1k) / 1000);
}

const GENDER_WORDS: Record<string, string> = { f: "female", m: "male" };
const LANGUAGE_WORDS: Record<string, string> = { th: "Thai", en: "English", zh: "Mandarin Chinese" };
const TRANSLATE_LANGUAGE_NAMES: Record<TranslateLanguage, string> = {
  th: "Thai",
  en: "English",
  zh: "Chinese",
  ja: "Japanese",
  ko: "Korean",
  ar: "Arabic",
  fr: "French",
  de: "German",
  hi: "Hindi",
  id: "Indonesian",
  ms: "Malay",
  pt: "Portuguese",
  ru: "Russian",
  es: "Spanish",
  vi: "Vietnamese",
};
/** Spelled out for the translate tool, so an agent maps a language name to its code without a lookup. */
const TRANSLATE_LANGUAGE_LIST = TRANSLATE_LANGUAGES.map((code) => `${TRANSLATE_LANGUAGE_NAMES[code]} (${code})`).join(", ");

/** "Nok (female, Thai), Pharmacist: A calm, warm voice that explains each step slowly." */
function designedVoiceSummary(v: DesignedVoiceWords): string {
  const traits = [GENDER_WORDS[v.gender] ?? v.gender, LANGUAGE_WORDS[v.language] ?? v.language].join(", ");
  return `${v.name} (${traits}), ${v.role}: ${v.description}`;
}

function notDesignedHere(id: string): string {
  return (
    `${id} is not one of this account's designed voices: it was deleted, belongs to another account, or the id is ` +
    "mistyped. list_voices shows the account's designed voices. Nothing changed."
  );
}

/** On the designed-voice endpoints, unknown_voice means the account holds no such voice; the speech hint would mislead. */
function designedVoiceFailure(err: unknown, id: string): CallToolResult {
  if (err instanceof PaxaApiError && err.code === "unknown_voice") {
    return failure(notDesignedHere(id) + (err.requestId ? ` [request id ${err.requestId}]` : ""));
  }
  return failure(err);
}

/** How many unsaved drafts this server keeps; the oldest goes first. */
const DRAFTS_KEPT = 50;

/**
 * Drafts from design_voice, kept in this process under short handles (draft-1, draft-2, ...) so an agent passes a
 * few characters instead of copying a sealed string of up to 4 KB, which a single wrong character would break.
 * A draft string from elsewhere (the Paxa console) passes through as is.
 */
class DraftStore {
  private readonly drafts = new Map<string, { draft: string; name: string }>();
  private next = 1;

  add(draft: string, name: string): string {
    const handle = `draft-${this.next++}`;
    this.drafts.set(handle, { draft, name });
    while (this.drafts.size > DRAFTS_KEPT) {
      const oldest = this.drafts.keys().next().value;
      if (oldest === undefined) break;
      this.drafts.delete(oldest);
    }
    return handle;
  }

  /** The sealed draft for a handle this server printed (and the handle), or the value itself when it is not a handle. Throws for a lost handle. */
  resolve(value: string): { draft: string; handle?: string } {
    const handle = value.trim();
    if (!/^draft-\d+$/.test(handle)) return { draft: value };
    const entry = this.drafts.get(handle);
    if (!entry) {
      throw new Error(
        `${handle} is not in this server's memory: drafts last until the server restarts, and only the last ` +
          `${DRAFTS_KEPT} are kept. Design the voice again with design_voice.`,
      );
    }
    return { draft: entry.draft, handle };
  }

  /** "draft-1 (Nok), draft-2 (Nok)", newest last; empty when there are none. */
  list(): string {
    return [...this.drafts.entries()].map(([handle, entry]) => `${handle} (${entry.name})`).join(", ");
  }
}

/** Shared guidance on choosing a voice; a hint, since some users prefer Thai-accented English. */
export const VOICE_GUIDANCE =
  "On paxa-tts-flash-v2 (the default) every voice speaks Thai, English, and Mandarin Chinese, so choose by " +
  "character and purpose from list_voices rather than by language. On paxa-tts-flash-v1 each voice is built " +
  "around one language and reads the others with an accent (English voices there: donut, cookie, toast, " +
  "latte, espresso, mocha), four Thai voices carry a regional accent, and khanomchan and kaprao read the " +
  "fixed emotion tag set. Follow the user's preference when they have one.";
/** The voices we recommend when nothing about the request points at a particular character. */
const VOICE_PICKS =
  "Recommended for general use: foithong (female) and massaman (male); khanomkrok (male), sanaechan (female), and " +
  "nomyen (female) are also good.";
/** Told once at connect time: users tend to have a favorite voice and talking style, so offer the choice once and remember it. */
const VOICE_PREFERENCE =
  "Voices have distinct styles and users tend to have a favorite, and many also prefer a talking style. Use the " +
  "default voice without asking, but the first time the user engages with speech or comments on how it sounds, " +
  "offer to pick a voice (list_voices, or a short sample of two or three) and a talking style, written on " +
  "paxa-tts-flash-v2 as a direction tag at the start of the text, such as [calm, casual] or [relaxed and friendly, " +
  "speaking softly]; play a sample of each style you offer. Remember both where you keep the user's preferences and " +
  "apply them on every call. PAXA_DEFAULT_VOICE in this server's config makes the voice the default without " +
  "passing it; the style has no setting, so it lives in your preferences. When no catalog voice fits what the " +
  "user wants, offer to design one with design_voice. ";
const MODEL_HINT =
  '"paxa-tts-flash-v2" (default) has 50 voices that each speak Thai, English, and Mandarin, and every one reads ' +
  "direction tags written into the text. Pick \"paxa-tts-flash-v1\" only for its legacy features: regional Thai " +
  "accents (Isan, Northern, Southern), the fixed emotion tags on khanomchan and kaprao, or one of the eight voices " +
  "v2 does not carry (donut, toast, padthai, yoyo, somtam, larb, khaosoi, roti). Same price and limits.";

/** The synthesis settings for one call: the call's values first, then the configured defaults. */
function speechOptions(
  config: Config,
  call: { language?: TtsLanguage | undefined; speed?: number | undefined; model?: TtsModel | undefined; temperature?: number | undefined },
): SpeechOptions {
  const out: SpeechOptions = { model: call.model ?? config.ttsModel };
  if (call.language) out.language = call.language;
  const rate = call.speed ?? config.defaultSpeed;
  if (rate !== undefined) out.speed = rate;
  if (call.temperature !== undefined) out.temperature = call.temperature;
  return out;
}

function voiceHint(config: Config): string {
  return (
    `Voice id from list_voices (default "${config.defaultVoice}"), or a designed voice's id (voice_...) from ` +
    `save_voice, which speaks only on paxa-tts-flash-v2. ${VOICE_PICKS} ${VOICE_GUIDANCE}`
  );
}

/** Seconds of audio in a headerless file: pcm is two bytes per sample at its rate, mulaw and alaw one byte at 8000 Hz. */
function rawSeconds(bytes: number, format: RawFormat, sampleRate: SampleRate | undefined): number {
  return format === "pcm" ? bytes / (2 * (sampleRate ?? 24000)) : bytes / 8000;
}

/** "mp3", "wav at 48000 Hz", or "pcm (16-bit little-endian mono at 16000 Hz, no header)". */
function formatLabel(format: AudioFormat, sampleRate: SampleRate | undefined): string {
  if (format === "pcm") return `pcm (16-bit little-endian mono at ${sampleRate ?? 24000} Hz, no header)`;
  if (format === "mulaw" || format === "alaw") return `${format} (G.711 at 8000 Hz, no header)`;
  return format === "wav" && sampleRate !== undefined ? `wav at ${sampleRate} Hz` : format;
}

const FORMAT_HINT =
  'Audio format (default "mp3"). opus is the smallest, wav is uncompressed 16-bit with a header, pcm is the same ' +
  "samples raw (little-endian mono, no header) for voice agents and audio pipelines, and mulaw and alaw are " +
  "G.711 at 8000 Hz with no header, for phone lines (paxa-tts-flash-v2 only).";
const SAMPLE_RATE_HINT =
  `Sample rate of pcm or wav in Hz (default 24000): ${SAMPLE_RATES.join(", ")} on paxa-tts-flash-v2; ` +
  "paxa-tts-flash-v1 serves 24000 only. Other formats have a fixed rate (8000 for mulaw and alaw).";
const OUTPUT_PATH_HINT = "Where to save the file. Relative paths resolve against PAXA_OUTPUT_DIR (or the working directory).";

/** output_path resolved against PAXA_OUTPUT_DIR, or a fresh name there. */
function outputTarget(config: Config, outputPath: string | undefined, fallbackName: string): string {
  if (!outputPath) return join(config.outputDir, fallbackName);
  return isAbsolute(outputPath) ? outputPath : join(config.outputDir, outputPath);
}

/** The caption file next to an audio file: same name, .srt or .vtt. */
function captionPathFor(audio: string, kind: "srt" | "vtt"): string {
  return join(dirname(audio), basename(audio, extname(audio)) + `.${kind}`);
}

function timestampName(voice: string, format: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `paxa-tts-${stamp}-${voice}.${format}`;
}

export function createServer(config: Config, client: PaxaClient, engine: SpeechEngine): McpServer {
  const keyWarning =
    config.apiKey || readStoredAuth()
      ? ""
      : " Not signed in yet: before the first tool that calls the API, call sign_in, which opens the Paxa sign-in " +
        "page in the user's browser for them to approve. control_playback and play_audio work without it.";
  const voiceWarning = defaultVoiceWarning(config);
  const defaultVoiceNote = voiceWarning ? ` WARNING: ${voiceWarning} Tell the user.` : "";
  const drafts = new DraftStore();
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
        "Paxa Labs API server: speech in Thai, English, and Mandarin Chinese, plus transcription, translation, and " +
        "document reading across languages. speak plays a short line out loud on " +
        "this machine; queue_speech reads long content aloud continuously; control_playback inspects and " +
        "controls the shared audio queue; text_to_speech writes an audio file without playing it; " +
        "dialogue_to_speech writes a conversation in several voices to one file; " +
        "design_voice makes a new voice from a description, refine_voice changes it in words, save_voice keeps it, " +
        "and rename_voice and delete_voice manage saved ones; " +
        "play_audio replays a local audio file; translate translates text between 15 languages; " +
        "ocr_document runs OCR on a local PDF or image; extract_fields fills a schema of typed " +
        "fields from a local document; transcribe_audio turns a local recording into text and " +
        "subtitles; listen records one spoken turn from the microphone and returns its transcript; sign_in " +
        "connects the user's Paxa account through their browser when no API key is configured. " +
        "Paid tools spend account credits " +
        "(check with get_account). " +
        VOICE_PREFERENCE +
        WHATS_NEW +
        keyWarning +
        defaultVoiceNote,
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
        `${TTS_PRICE_NOTE} ${EMOTION_TAG_HINT}`,
      inputSchema: {
        text: z.string().min(1).max(2000).describe("Text to speak, Thai, English, or Mandarin Chinese, up to 2000 characters"),
        voice: z.string().optional().describe(voiceHint(config)),
        language: z.enum(["auto", "th", "en", "zh"]).optional().describe(TTS_LANGUAGE_HINT),
        speed: z.number().min(0.5).max(1.5).optional().describe(SPEED_HINT),
        temperature: z.number().min(0).max(2).optional().describe(TEMPERATURE_HINT),
        model: z.enum(TTS_MODELS).optional().describe(MODEL_HINT),
      },
    },
    async ({ text: input, voice, language, speed, temperature, model }) => {
      try {
        const options = speechOptions(config, { language, speed, temperature, model });
        const [segment] = engine.enqueueTts([input], voice ?? config.defaultVoice, true, options);
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
        "synthesizes ahead while playing, and returns at once with the segment count and the estimated credits; " +
        "segments play in order after anything already queued. There is no handle: control_playback monitors and " +
        "controls the whole queue. Use speak instead for one short line that should play now and wait, and " +
        "text_to_speech for a file without playback. " +
        `${TTS_PRICE_NOTE} ${EMOTION_TAG_HINT}`,
      inputSchema: {
        text: z.string().min(1).max(200_000).describe("Text to read aloud, Thai, English, or Mandarin Chinese"),
        voice: z.string().optional().describe(voiceHint(config)),
        language: z.enum(["auto", "th", "en", "zh"]).optional().describe(TTS_LANGUAGE_HINT),
        speed: z.number().min(0.5).max(1.5).optional().describe(SPEED_HINT),
        temperature: z.number().min(0).max(2).optional().describe(TEMPERATURE_HINT),
        model: z.enum(TTS_MODELS).optional().describe(MODEL_HINT),
      },
    },
    async ({ text: input, voice, language, speed, temperature, model }) => {
      try {
        const chunks = chunkText(input);
        if (chunks.length === 0) return failure("The text contains nothing to read.");
        const chosenVoice = voice ?? config.defaultVoice;
        const segments = engine.enqueueTts(chunks, chosenVoice, false, speechOptions(config, { language, speed, temperature, model }));
        const chars = chunks.reduce((sum, c) => sum + c.length, 0);
        const credits = (chars * ttsRate(chosenVoice, false)) / 1000;
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
        "Inspect and control the shared audio queue that speak, queue_speech, play_audio, and the voice design " +
        "tools play through. status reports what is playing, what is queued, and any synthesis failures. pause " +
        "holds playback until resume or clear, and audio queued meanwhile waits; pause is not supported on " +
        "Windows, where skip or clear stops playback instead. skip drops the current segment and is refused when " +
        "nothing is playing. clear stops playback and discards every queued segment, which must be queued again " +
        "to be heard; audio files already written stay on disk. Free (no API call).",
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
        "earlier by text_to_speech. Waits for the audio playing now, plays ahead of queued long-form speech, and " +
        "blocks until the file ends; control_playback skip or clear stops it early. Fails without playing when " +
        "the file is missing, is not a playable format, or no audio player is installed; raw pcm, mulaw, and alaw " +
        "files have no header and cannot be played. To say new text, use speak instead. Free (no API call).",
      inputSchema: {
        file_path: z
          .string()
          .describe(
            "Path to a local audio file (mp3, wav, opus, ogg, flac, m4a, aac, aiff, caf), absolute or relative to the " +
              "server's working directory",
          ),
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
        "Synthesize speech with Paxa TTS and save it as an audio file without playing it: voiceovers, " +
        "narration, audiobooks, phone prompts. To hear speech instead, use speak (a short line) or queue_speech " +
        "(long reads); play_audio plays a saved file later. The file goes to output_path, replacing a file " +
        `already there, or to a new timestamped name in PAXA_OUTPUT_DIR. For several speakers in one file, use ` +
        `dialogue_to_speech. Text beyond ${TTS_MAX_STREAM_CHARS} characters is split at paragraphs and ` +
        "sentences and the parts are joined into one file (mp3, opus, and wav need ffmpeg for that). With subtitles " +
        "set, an srt or vtt caption file that matches the voice word for word is written next to the audio. " +
        `Costs ${TTS_CREDITS_PER_1K} credits per ` +
        `1000 characters, ${TTS_TIMED_RATE} with subtitles, ${TTS_DESIGNED_RATE} in a designed voice (voice_...), ` +
        `${TTS_DESIGNED_TIMED_RATE} with both; every format and sample rate costs the same. ${EMOTION_TAG_HINT}`,
      inputSchema: {
        text: z
          .string()
          .min(1)
          .max(TTS_LONG_TEXT_MAX)
          .describe(`Text to synthesize, Thai, English, or Mandarin Chinese, up to ${TTS_LONG_TEXT_MAX} characters`),
        voice: z.string().optional().describe(voiceHint(config)),
        language: z.enum(["auto", "th", "en", "zh"]).optional().describe(TTS_LANGUAGE_HINT),
        speed: z.number().min(0.5).max(1.5).optional().describe(SPEED_HINT),
        temperature: z.number().min(0).max(2).optional().describe(TEMPERATURE_HINT),
        model: z.enum(TTS_MODELS).optional().describe(MODEL_HINT),
        format: z.enum(AUDIO_FORMATS).optional().describe(FORMAT_HINT),
        sample_rate: z.literal(SAMPLE_RATES).optional().describe(SAMPLE_RATE_HINT),
        output_path: z.string().optional().describe(OUTPUT_PATH_HINT),
        subtitles: z
          .enum(["srt", "vtt"])
          .optional()
          .describe(
            "Also write a caption file (same name as the audio, .srt or .vtt) timed from the synthesized words: " +
              "cues break at sentence punctuation, at pauses, and at the line budget, never inside a word, Thai included. Bills 1.25x, 1.5x in a designed voice.",
          ),
        subtitle_line_chars: z
          .number()
          .int()
          .min(10)
          .max(120)
          .optional()
          .describe(SUBTITLE_COLUMNS_HINT),
      },
    },
    async ({ text: input, voice, language, speed, temperature, model, format, sample_rate, output_path, subtitles, subtitle_line_chars }) => {
      let workDir: string | null = null;
      try {
        const chosenVoice = voice ?? config.defaultVoice;
        const chosenFormat: AudioFormat = format ?? "mp3";
        const options = speechOptions(config, { language, speed, temperature, model });
        const chunks = input.length <= TTS_MAX_STREAM_CHARS ? [input] : chunkText(input, TTS_MAX_STREAM_CHARS);
        if (chunks.length === 0) return failure("The text contains nothing to synthesize.");
        if (chunks.length > 1 && !isRawFormat(chosenFormat) && !(hasFfmpeg() && hasFfprobe())) {
          return failure(
            `The text is ${input.length} characters, over the ${TTS_MAX_STREAM_CHARS} the API takes in one request, and ` +
              `joining ${chosenFormat} parts needs ffmpeg, which is not installed. ${FFMPEG_INSTALL_HINT} Or send up to ` +
              `${TTS_MAX_STREAM_CHARS} characters per call.`,
          );
        }

        const target = outputTarget(config, output_path, timestampName(chosenVoice, chosenFormat));
        await mkdir(dirname(target), { recursive: true });

        const request = (part: string): TtsRequest => ({
          text: part,
          voice: chosenVoice,
          format: chosenFormat,
          ...(sample_rate !== undefined ? { sample_rate } : {}),
          ...options,
        });
        // Streamed requests take four times the text of buffered ones; a stream that breaks off throws.
        const synthesize = async (part: string): Promise<{ audio: Buffer; spans: WordSpan[] }> => {
          const result = subtitles ? await client.ttsWholeTimed(request(part)) : { audio: await client.ttsWhole(request(part)), spans: [] };
          if (chosenFormat === "wav") fixWavSizes(result.audio);
          return result;
        };

        const spans: WordSpan[] = [];
        if (chunks.length === 1) {
          const result = await synthesize(chunks[0] as string);
          spans.push(...result.spans);
          await writeFile(target, result.audio);
        } else {
          // Synthesize the parts one at a time (one request in flight keeps low-concurrency plans safe), each saved
          // as it arrives, then join them: raw samples by appending, containers with ffmpeg.
          const dir = await mkdtemp(join(tmpdir(), "paxa-tts-"));
          workDir = dir;
          const parts: string[] = [];
          let offset = 0;
          for (let i = 0; i < chunks.length; i++) {
            const result = await synthesize(chunks[i] as string);
            const part = join(dir, `part-${String(i + 1).padStart(3, "0")}.${chosenFormat}`);
            await writeFile(part, result.audio);
            parts.push(part);
            for (const span of result.spans) spans.push({ text: span.text, start: span.start + offset, end: span.end + offset });
            if (subtitles) {
              offset += isRawFormat(chosenFormat) ? rawSeconds(result.audio.length, chosenFormat, sample_rate) : joinedSeconds(part);
            }
          }
          if (isRawFormat(chosenFormat)) await concatRaw(parts, target);
          else await concatAudio(parts, target, chosenFormat, join(dir, "parts.txt"));
        }
        const bytes = (await stat(target)).size;

        const credits = estimateTtsCredits(input.length, ttsRate(chosenVoice, Boolean(subtitles)));
        const lines = [
          `Saved ${(bytes / 1024).toFixed(1)} KiB of ${formatLabel(chosenFormat, sample_rate)} audio to ${target} ` +
            `(voice "${chosenVoice}", model ${options.model}, ${input.length} characters` +
            (chunks.length > 1 ? `, ${chunks.length} parts joined` : "") +
            `, about ${credits.toFixed(1)} credits).`,
        ];
        if (subtitles) {
          const cues = buildCues(markSpacing(spans, input), subtitle_line_chars != null ? { lineChars: subtitle_line_chars } : {});
          const captionPath = captionPathFor(target, subtitles);
          await writeFile(captionPath, subtitles === "srt" ? toSrt(cues) : toVtt(cues), "utf8");
          lines.push(`Captions: ${captionPath} (${cues.length} cues, ${spans.length} words timed).`);
        }
        return text(lines.join("\n"));
      } catch (err) {
        return failure(err);
      } finally {
        if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  server.registerTool(
    "dialogue_to_speech",
    {
      title: "Dialogue to speech (file only)",
      annotations: { title: "Dialogue to speech (file only)", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      description:
        "Synthesize a script of lines, each in its own voice, into one audio file without playing it: podcasts, " +
        "interviews, radio plays, lessons and phone flows with more than one speaker. Pass the lines in speaking order " +
        "with a voice each; gap_ms of silence goes between lines. For a single voice use text_to_speech; to hear a " +
        "conversation now, call queue_speech once per line in that line's voice; play_audio plays the saved file. " +
        "The file goes to output_path, replacing a file already there, or to a new timestamped name in " +
        `PAXA_OUTPUT_DIR. A script over ${DIALOGUE_MAX_LINES} lines or ${DIALOGUE_MAX_CHARS} characters is sent in ` +
        "parts split between lines and joined with the same gap (mp3, opus, and wav need ffmpeg for that). Returns " +
        "each line's start and end in the audio. With subtitles set, an srt or vtt caption file is written next to " +
        "the audio, and no cue spans two lines. If synthesis fails partway, the lines already delivered whole, which " +
        "were paid for, are saved and the result names the line to resume from. Costs the same as text_to_speech for " +
        `the characters of every line: ${TTS_CREDITS_PER_1K} credits per 1000, ${TTS_TIMED_RATE} with subtitles, ` +
        `${TTS_DESIGNED_RATE} for a line in a designed voice (voice_...), ${TTS_DESIGNED_TIMED_RATE} with both; the ` +
        `gap is free. ${EMOTION_TAG_HINT}`,
      inputSchema: {
        lines: z
          .array(
            z.object({
              text: z.string().min(1).describe("What this line says, with any direction tags for its delivery"),
              voice: z
                .string()
                .min(1)
                .describe("The voice that speaks it: a voice id from list_voices, or a designed voice's id (voice_...)"),
            }),
          )
          .min(1)
          .max(DIALOGUE_SCRIPT_MAX_LINES)
          .describe(
            `The lines in speaking order, up to ${DIALOGUE_SCRIPT_MAX_LINES} lines and ${TTS_LONG_TEXT_MAX} characters ` +
              `in all, at most ${DIALOGUE_MAX_CHARS} in one line. Give each speaker a voice of their own. ${VOICE_PICKS}`,
          ),
        gap_ms: z
          .number()
          .int()
          .min(0)
          .max(5000)
          .optional()
          .describe("Silence between one line and the next, in milliseconds (default 300). For a pause inside a line, write a pause tag."),
        language: z.enum(["auto", "th", "en", "zh"]).optional().describe(TTS_LANGUAGE_HINT),
        speed: z.number().min(0.5).max(1.5).optional().describe(SPEED_HINT),
        temperature: z.number().min(0).max(2).optional().describe(TEMPERATURE_HINT),
        model: z.enum(TTS_MODELS).optional().describe(MODEL_HINT),
        format: z.enum(AUDIO_FORMATS).optional().describe(FORMAT_HINT),
        sample_rate: z.literal(SAMPLE_RATES).optional().describe(SAMPLE_RATE_HINT),
        output_path: z.string().optional().describe(OUTPUT_PATH_HINT),
        subtitles: z
          .enum(["srt", "vtt"])
          .optional()
          .describe(
            "Also write a caption file (same name as the audio, .srt or .vtt) timed from the synthesized words. Cues " +
              "break at sentence punctuation, at pauses, and at the line budget, never inside a word and never across " +
              "two lines of the script. Bills 1.25x, 1.5x for a line in a designed voice.",
          ),
        subtitle_line_chars: z.number().int().min(10).max(120).optional().describe(SUBTITLE_COLUMNS_HINT),
      },
    },
    async ({ lines, gap_ms, language, speed, temperature, model, format, sample_rate, output_path, subtitles, subtitle_line_chars }) => {
      let workDir: string | null = null;
      try {
        const chosenFormat: AudioFormat = format ?? "mp3";
        const gap = gap_ms ?? 300;
        const options = speechOptions(config, { language, speed, temperature, model });
        const total = lines.reduce((n, line) => n + line.text.length, 0);
        if (total > TTS_LONG_TEXT_MAX) {
          return failure(`The script is ${total} characters; one call takes up to ${TTS_LONG_TEXT_MAX}. Split it into several files.`);
        }
        const overlong = lines.findIndex((line) => line.text.length > DIALOGUE_MAX_CHARS);
        if (overlong >= 0) {
          return failure(
            `Line ${overlong + 1} is ${lines[overlong]?.text.length} characters; one line holds at most ${DIALOGUE_MAX_CHARS}. ` +
              "Split it into several lines in the same voice.",
          );
        }

        // The requests the API takes, split between lines.
        const groups: Array<{ first: number; lines: DialogueLine[] }> = [];
        let groupChars = 0;
        lines.forEach((line, i) => {
          const last = groups[groups.length - 1];
          if (!last || last.lines.length >= DIALOGUE_MAX_LINES || groupChars + line.text.length > DIALOGUE_MAX_CHARS) {
            groups.push({ first: i, lines: [line] });
            groupChars = line.text.length;
          } else {
            last.lines.push(line);
            groupChars += line.text.length;
          }
        });
        if (groups.length > 1 && !isRawFormat(chosenFormat) && !(hasFfmpeg() && hasFfprobe())) {
          return failure(
            `The script is ${lines.length} lines and ${total} characters, over the ${DIALOGUE_MAX_LINES} lines or ` +
              `${DIALOGUE_MAX_CHARS} characters the API takes in one request, and joining ${chosenFormat} parts needs ` +
              `ffmpeg, which is not installed. ${FFMPEG_INSTALL_HINT} Or use pcm, mulaw, or alaw, which join without it.`,
          );
        }

        const target = outputTarget(config, output_path, timestampName("dialogue", chosenFormat));
        await mkdir(dirname(target), { recursive: true });
        const dir = await mkdtemp(join(tmpdir(), "paxa-dialogue-"));
        workDir = dir;

        // One request at a time (low-concurrency plans stay safe). Each part is saved as it arrives, with the same
        // silence the API puts between lines at every seam, and the times move along by what came before.
        const parts: string[] = [];
        const placed: Array<{ start: number; end: number } | undefined> = [];
        const spans: Array<WordSpan & { line: number }> = [];
        const requestIds: string[] = [];
        let credits: number | undefined = 0;
        let offset = 0;
        let delivered = 0;
        let stopped: Error | undefined;
        let silence: { file: string; seconds: number } | undefined;
        for (const [g, group] of groups.entries()) {
          let result: DialogueOutcome;
          try {
            result = await client.dialogue({
              lines: group.lines,
              format: chosenFormat,
              ...(sample_rate !== undefined ? { sample_rate } : {}),
              ...options,
              gap_ms: gap,
              ...(subtitles ? { timestamps: "word" as const } : {}),
            });
          } catch (err) {
            if (err instanceof PaxaApiError && err.line !== undefined) err.line += group.first;
            if (g === 0) throw err;
            stopped = err instanceof Error ? err : new Error(String(err));
            break;
          }
          if (result.requestId) requestIds.push(result.requestId);
          credits = credits === undefined || result.credits === undefined ? undefined : credits + result.credits;
          if (result.failure instanceof PaxaApiError && result.failure.line !== undefined) result.failure.line += group.first;

          if (result.whole > 0) {
            if (g > 0 && gap > 0) {
              if (!silence) {
                const file = join(dir, `gap.${chosenFormat}`);
                if (isRawFormat(chosenFormat)) {
                  const bytes = rawSilence(chosenFormat, sample_rate ?? 24000, gap);
                  await writeFile(file, bytes);
                  silence = { file, seconds: rawSeconds(bytes.length, chosenFormat, sample_rate) };
                } else {
                  await makeSilence(parts[0] as string, gap / 1000, file, chosenFormat);
                  silence = { file, seconds: joinedSeconds(file) };
                }
              }
              parts.push(silence.file);
              offset += silence.seconds;
            }
            const file = join(dir, `part-${String(g + 1).padStart(3, "0")}.${chosenFormat}`);
            await writeFile(file, chosenFormat === "wav" ? fixWavSizes(result.audio) : result.audio);
            parts.push(file);
            result.lines.forEach((t, i) => (placed[group.first + i] = { start: t.start + offset, end: t.end + offset }));
            for (const span of result.spans) {
              spans.push({ text: span.text, start: span.start + offset, end: span.end + offset, line: group.first + span.line });
            }
            delivered = group.first + result.whole;
            if (!result.failure && g < groups.length - 1) {
              offset += isRawFormat(chosenFormat) ? rawSeconds(result.audio.length, chosenFormat, sample_rate) : joinedSeconds(file);
            }
          }
          if (result.failure) {
            stopped = result.failure;
            break;
          }
        }

        if (parts.length === 0) throw stopped ?? new Error("Nothing was synthesized.");
        if (parts.length === 1) await copyFile(parts[0] as string, target);
        else if (isRawFormat(chosenFormat)) await concatRaw(parts, target);
        else await concatAudio(parts, target, chosenFormat, join(dir, "parts.txt"));
        const bytes = (await stat(target)).size;

        const voices = [...new Set(lines.slice(0, delivered).map((line) => line.voice))];
        const cost =
          credits !== undefined
            ? `${credits.toFixed(2)} credits`
            : `about ${lines
                .slice(0, delivered)
                .reduce((n, line) => n + estimateTtsCredits(line.text.length, ttsRate(line.voice, Boolean(subtitles))), 0)
                .toFixed(1)} credits`;
        const out = [
          `Saved ${(bytes / 1024).toFixed(1)} KiB of ${formatLabel(chosenFormat, sample_rate)} audio to ${target} ` +
            `(${delivered} line${delivered === 1 ? "" : "s"} in ${voices.length} voice${voices.length === 1 ? "" : "s"}: ` +
            `${voices.join(", ")}; model ${options.model}, ${gap} ms between lines` +
            (parts.length > 1 ? `, ${groups.length} requests joined` : "") +
            `, ${cost}).`,
        ];
        const timed = placed.slice(0, delivered);
        if (timed.some((t) => t !== undefined)) {
          out.push("Lines (start to end, seconds):");
          timed.slice(0, LINE_TIMINGS_INLINE).forEach((t, i) => {
            out.push(`${i + 1}. ${lines[i]?.voice}: ${t ? `${t.start.toFixed(2)} to ${t.end.toFixed(2)}` : "not reported"}`);
          });
          if (timed.length > LINE_TIMINGS_INLINE) out.push(`(${timed.length - LINE_TIMINGS_INLINE} more lines not listed)`);
        }
        if (subtitles && spans.length > 0) {
          const lineChars = subtitle_line_chars ?? defaultLineChars(lines.map((line) => line.text).join(""));
          const byLine = new Map<number, WordSpan[]>();
          for (const span of spans) {
            const group = byLine.get(span.line);
            if (group) group.push(span);
            else byLine.set(span.line, [span]);
          }
          const cues: Cue[] = [];
          for (const [i, lineSpans] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
            cues.push(...buildCues(markSpacing(lineSpans, lines[i]?.text ?? ""), { lineChars }));
          }
          const captionPath = captionPathFor(target, subtitles);
          await writeFile(captionPath, subtitles === "srt" ? toSrt(cues) : toVtt(cues), "utf8");
          out.push(`Captions: ${captionPath} (${cues.length} cues, ${spans.length} words timed).`);
        }
        if (requestIds.length > 0) out.push(`Request id${requestIds.length > 1 ? "s" : ""}: ${requestIds.join(", ")}.`);
        if (!stopped) return text(out.join("\n"));

        const why = stopped instanceof PaxaApiError ? stopped.display() : stopped.message;
        out.unshift(
          `Stopped at line ${delivered + 1} of ${lines.length} (${lines[delivered]?.voice}): ${why}`,
          `The ${delivered} line${delivered === 1 ? "" : "s"} before it arrived whole and were paid for, so they are saved. ` +
            `To finish, call dialogue_to_speech again with lines ${delivered + 1} onward and another output_path, then join the files.`,
        );
        return { content: [{ type: "text", text: out.join("\n") }], isError: true };
      } catch (err) {
        return failure(err);
      } finally {
        if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  /** One design or refine turn: call the API, keep the draft under a handle, save the line, and play it unless asked not to. */
  async function designTurn(request: VoiceDesignRequest, from: string | undefined, play: boolean | undefined): Promise<CallToolResult> {
    const result = await client.designVoice(request);
    const handle = drafts.add(result.draft, result.voice.name);
    // The turn is paid for and its draft kept: from here on nothing may hide the handle, so a file or playback
    // problem becomes a note, and a paused queue (which would block until resumed) is not waited on.
    let played: string;
    try {
      const file = engine.scratchPath(`voice-design-${handle}.mp3`);
      await writeFile(file, Buffer.from(result.audio, "base64"));
      if (play === false) {
        played = `Not played; the line is at ${file}`;
      } else if (engine.status().state === "paused") {
        played = `Not played, because playback is paused (control_playback resumes it); the line is at ${file}`;
      } else {
        const settled = await engine.waitFor(engine.enqueueFile(file));
        played =
          settled.status === "done"
            ? `Played it; the line is at ${file}`
            : settled.status === "skipped" || settled.status === "cleared"
              ? `Playback was ${settled.status}; the line is at ${file}`
              : `Could not play it (${settled.error ?? "unknown error"}); the line is at ${file}`;
      }
    } catch (err) {
      played = `Could not save or play the line (${err instanceof Error ? err.message : String(err)})`;
    }

    return text(
      [
        `${from ? `Refined ${from} into` : "Designed"} ${handle}: ${designedVoiceSummary(result.voice)}`,
        `Line: "${result.voice.line}". ${played}.`,
        `To change it, call refine_voice with draft "${handle}" and an instruction. To keep it, call save_voice with ` +
          `draft "${handle}". Unsaved drafts last until this server restarts.`,
        `${result.usage.credits} credits.` + (result.requestId ? ` Request id: ${result.requestId}.` : ""),
      ].join("\n"),
    );
  }

  const PLAY_HINT = "Play the voice's line out loud (default true). The line is saved to a file either way.";
  const DRAFT_HINT =
    'A draft handle that design_voice or refine_voice printed (such as "draft-2"), or a draft string from the Paxa console.';

  server.registerTool(
    "design_voice",
    {
      title: "Design a new voice",
      annotations: { title: "Design a new voice", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        "Make a new voice from a written description and play the line it speaks through this machine's speakers. " +
        "Use it when the user wants a voice the catalog does not have. Describe who is speaking and how they sound in " +
        "one or two sentences: age, gender, role, pitch and texture, pace and manner, where it will be heard, and the " +
        "language it speaks (a designed voice speaks one language: the one the description names, otherwise the one " +
        'it is written in), such as "A calm Bangkok pharmacist in her thirties who explains dosages slowly and kindly, ' +
        'speaking Thai". Leave out real people\'s names, sound effects, and what the voice should say. The result is a ' +
        "draft, not yet a voice: refine_voice changes it, save_voice keeps it. " +
        `Costs ${DESIGN_CREDITS} credits per call, the line included; a retry designs again and is charged again.`,
      inputSchema: {
        description: z
          .string()
          .min(1)
          .max(1000)
          .describe("Who the voice is and how it sounds, in English, Thai, or Chinese, up to 1000 characters"),
        play: z.boolean().optional().describe(PLAY_HINT),
      },
    },
    async ({ description, play }) => {
      try {
        return await designTurn({ description }, undefined, play);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "refine_voice",
    {
      title: "Refine a draft voice",
      annotations: { title: "Refine a draft voice", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        "Change a draft voice in words and play its new line. The instruction says what to change, such as \"a little " +
        'lower and slower" or "warmer, and older"; the rest of the voice stays, so change one quality at a time. Each ' +
        "call returns a new draft handle and the earlier handles keep their versions, so the user can go back to one. " +
        "save_voice keeps the draft the user picks. Refining never changes a voice already saved: saving a refined " +
        "draft makes another voice, and rename_voice changes only a name. " +
        `Costs ${DESIGN_CREDITS} credits per call, the line included; a retry refines again and is charged again.`,
      inputSchema: {
        draft: z.string().min(1).max(4096).describe(DRAFT_HINT),
        instruction: z.string().min(1).max(500).describe("What to change about the voice, up to 500 characters"),
        play: z.boolean().optional().describe(PLAY_HINT),
      },
    },
    async ({ draft, instruction, play }) => {
      try {
        const resolved = drafts.resolve(draft);
        return await designTurn({ draft: resolved.draft, instruction }, resolved.handle, play);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "save_voice",
    {
      title: "Save a designed voice",
      annotations: { title: "Save a designed voice", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Save a draft from design_voice or refine_voice as one of the account's voices, and get its id (voice_...), " +
        "which speak, queue_speech, and text_to_speech accept as voice on paxa-tts-flash-v2, for this account only. " +
        "Save only the draft the user picked. Saving the same draft again returns the same voice and uses no slot. A " +
        "saved voice's sound never changes: design a new voice for a different sound. The plan sets how many voices " +
        "the account keeps (Free 1, Starter 3, Standard 10, Pro 50); list_voices shows the slots in use. Free.",
      inputSchema: {
        draft: z.string().min(1).max(4096).describe(DRAFT_HINT),
        name: z
          .string()
          .min(1)
          .max(60)
          .optional()
          .describe("A name for the voice, up to 60 characters (default: the name the design gave it). A catalog voice's name is refused."),
      },
    },
    async ({ draft, name }) => {
      try {
        const saved = await client.saveVoice({ draft: drafts.resolve(draft).draft, ...(name !== undefined ? { name } : {}) });
        const lines = [
          `Saved ${saved.id}: ${designedVoiceSummary(saved)}`,
          `Pass voice "${saved.id}" to speak, queue_speech, or text_to_speech` +
            (config.ttsModel === "paxa-tts-flash-v2" ? "" : ' with model "paxa-tts-flash-v2" (this server defaults to v1)') +
            `; speech in it costs ${ttsRate(saved.id, false)} credits per 1000 characters. To make it the default voice, ` +
            `set PAXA_DEFAULT_VOICE=${saved.id} in this server's config.`,
        ];
        const listed = await client.designedVoices().catch(() => undefined);
        if (listed) lines.push(`Voice slots: ${listed.slots.used} of ${listed.slots.limit} in use.`);
        return text(lines.join("\n"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "rename_voice",
    {
      title: "Rename a designed voice",
      annotations: { title: "Rename a designed voice", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Rename one of the account's designed voices, given its voice_ id from list_voices or save_voice. The id " +
        "and the sound stay the same, so anything that uses the id keeps working. The new name takes 1 to 60 " +
        "characters, and a catalog voice's name is refused. To change how a voice sounds, refine a draft and save " +
        "it as a new voice; to remove one, use delete_voice. Free.",
      inputSchema: {
        id: z.string().min(1).describe("The designed voice's id (voice_...), from list_voices or save_voice"),
        name: z.string().min(1).max(60).describe("The new name, up to 60 characters"),
      },
    },
    async ({ id, name }) => {
      if (!isDesignedVoice(id)) return failure(`${id} is not a designed voice; designed voice ids start with voice_.`);
      try {
        const renamed = await client.renameVoice(id, name);
        return text(`Renamed ${renamed.id} to "${renamed.name}". The id and the sound stay the same.`);
      } catch (err) {
        return designedVoiceFailure(err, id);
      }
    },
  );

  server.registerTool(
    "delete_voice",
    {
      title: "Delete a designed voice",
      annotations: { title: "Delete a designed voice", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
      description:
        "Delete one of the account's designed voices and free its slot. The id is the voice_ id list_voices shows; " +
        "it is looked up first, so an id the account does not have is answered without deleting anything, and " +
        "catalog voices cannot be deleted. Cannot be undone: every later request in the voice fails, and designing " +
        "again does not bring the same sound back. Use it only when the user asks to delete that voice; to change " +
        "only its name, use rename_voice. Free.",
      inputSchema: {
        id: z.string().min(1).describe("The designed voice's id (voice_...), from list_voices or save_voice"),
      },
    },
    async ({ id }) => {
      try {
        if (!isDesignedVoice(id)) return failure(`${id} is not a designed voice; only designed voices (voice_...) can be deleted.`);
        const before = await client.designedVoices().catch(() => undefined);
        const named = before?.voices.find((v) => v.id.toLowerCase() === id.toLowerCase());
        if (before && !named) return failure(notDesignedHere(id));
        const deleted = await client.deleteVoice(id).catch((err: unknown) => designedVoiceFailure(err, id));
        if ("content" in deleted) return deleted;
        const lines = [`Deleted ${deleted.id}${named ? ` ("${named.name}")` : ""}.`];
        if (before && named) lines.push(`Voice slots: ${before.slots.used - 1} of ${before.slots.limit} in use.`);
        if (config.defaultVoice.toLowerCase() === id.toLowerCase()) {
          lines.push(
            "PAXA_DEFAULT_VOICE still names this voice, so every speech call that does not pick a voice will fail " +
              "until the user changes it. Tell the user.",
          );
        }
        return text(lines.join("\n"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "translate",
    {
      title: "Translate text",
      annotations: { title: "Translate text", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Translate text into any of 15 languages, from any of them, with Paxa Translate: " +
        `${TRANSLATE_LANGUAGE_LIST}. The source language is detected per segment, so mixed-language text works; ` +
        "a segment already in the target language comes back unchanged. Accepts one string or up to 200 segments " +
        "that share context, and returns each translation (numbered for segments) with its detected source " +
        "language, any review flag, and the credits used. For text " +
        "in a PDF or image, run ocr_document first. Costs 25 credits per 1000 text characters per rendering " +
        "(minimum 2 credits), so 1000 characters cost 25 credits, or 50 with alternatives 2; instructions, " +
        "context, examples, do_not_translate strings, and glossary terms bill at 8 per 1000.",
      inputSchema: {
        text: z
          .union([z.string().min(1).max(20_000), z.array(z.string().min(1)).min(1).max(200)])
          .describe("Text to translate: one string, or an array of segments translated together"),
        target: z
          .enum(TRANSLATE_LANGUAGES)
          .describe('The language to write, as its code (see the description). Chinese ("zh") is written in Simplified characters.'),
        source: z
          .enum([...TRANSLATE_LANGUAGES, "auto"])
          .optional()
          .describe('Pin the source language only when detection gets it wrong (default "auto", detected per segment). Must differ from target.'),
        formality: z
          .enum(["auto", "formal", "casual"])
          .optional()
          .describe(
            '"auto" (default) matches the tone of the source; "formal" writes the target language\'s polite written ' +
              'register (polite particles in Thai, the polite form of address where a language has one); "casual" ' +
              "writes conversational language between peers.",
          ),
        borrowed_words: z
          .enum(["auto", "transliterate", "preserve"])
          .optional()
          .describe(
            'How to render borrowed words: "auto" (default) uses the established form in the target language, ' +
              '"transliterate" writes them in the target script, "preserve" keeps technical terms and proper nouns in their original script',
          ),
        format: z
          .enum(["text", "markdown", "html"])
          .optional()
          .describe("Treat input as plain text, Markdown, or HTML; only the prose of Markdown and HTML is translated, links, code, and tags come back untouched"),
        alternatives: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Renderings per segment, best first (default 1). Each one bills the text again and counts against the 20,000-character text limit."),
        instructions: z
          .string()
          .max(4000)
          .optional()
          .describe("Free-form direction for the translator: tone, audience, house rules, terminology. Style only."),
        context: z
          .string()
          .max(100_000)
          .optional()
          .describe("Background that conditions the translation without being translated: the surrounding document, the domain, the audience"),
        examples: z
          .array(z.object({ source: z.string().min(1).max(2000), target: z.string().min(1).max(2000) }))
          .max(100)
          .optional()
          .describe("Style examples: source sentences with their preferred translations, whose tone and phrasing the translation follows. Up to 100 pairs."),
        do_not_translate: z.array(z.string()).max(100).optional().describe("Strings that must appear in the translation exactly as written"),
        glossary: z
          .array(
            z.object({
              source: z.string().min(1).max(200),
              target: z.string().min(1).max(200),
              always: z
                .boolean()
                .optional()
                .describe("Send the term even when its source does not appear in the text, such as an abbreviation the text spells out"),
            }),
          )
          .max(5000)
          .optional()
          .describe(
            "Term pairs the translation must use, applied in context (inflected and placed grammatically). Send the whole " +
              "glossary: terms whose source does not appear in the text are dropped before the request runs and never billed.",
          ),
      },
    },
    async ({ text: input, ...options }) => {
      try {
        const request: TranslateRequest = { text: input, target: options.target };
        if (options.source) request.source = options.source;
        if (options.formality) request.formality = options.formality;
        if (options.borrowed_words) request.borrowed_words = options.borrowed_words;
        if (options.format) request.format = options.format;
        if (options.alternatives) request.alternatives = options.alternatives;
        if (options.instructions) request.instructions = options.instructions;
        if (options.context) request.context = options.context;
        if (options.examples) request.examples = options.examples;
        if (options.do_not_translate) request.do_not_translate = options.do_not_translate;
        if (options.glossary) request.glossary = options.glossary;

        const response = await client.translate(request);
        const lines = response.translations.map((t, i) => {
          const head = response.translations.length > 1 ? `[${i + 1}] ` : "";
          const source = t.detected_source ? ` (detected source: ${t.detected_source})` : "";
          const others = (t.alternatives ?? []).map((alt, k) => `\n${head}alternative ${k + 2}: ${alt}`).join("");
          const review = t.review ? `\n${head}review flag: ${t.review.reason}${t.review.detail ? `, ${t.review.detail}` : ""}` : "";
          return `${head}${t.text}${source}${others}${review}`;
        });
        const usage = response.usage;
        lines.push(
          `\nUsed ${usage.credits} credits (${usage.billable_chars} billable characters)` +
            (usage.glossary_terms_available
              ? `; ${usage.glossary_terms_sent ?? 0} of ${usage.glossary_terms_available} glossary terms matched the text and were sent.`
              : "."),
        );
        if (response.requestId) lines.push(`Request id: ${response.requestId}`);
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
        "GitHub-flavored Markdown (or structured blocks). Reads Thai, English, Simplified Chinese, and other " +
        "languages as printed, pages that mix them included, with no language setting; text set in two columns " +
        "reads column by column. output \"structured\" returns typed blocks as JSON instead of Markdown. Use " +
        "extract_fields instead for specific values (a total, a date, an ID number) checked and typed against a " +
        "schema. Up to 50 pages and 10 MiB per file. Costs 6.5 credits per page.",
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
        const usage =
          `Read ${response.usage.pages} page(s) for ${response.usage.credits} credits.` +
          (response.requestId ? ` Request id: ${response.requestId}.` : "");

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
    "extract_fields",
    {
      title: "Extract fields from a document",
      annotations: { title: "Extract fields from a document", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        "Extract typed fields from a local PDF, PNG, JPEG, or WebP document (up to 20 pages and 10 MiB) with " +
        "Paxa Document Extraction. You write a schema of fields; every value returned is text printed in the " +
        "document, read as the field's type, or null with the reason. Nothing is inferred or looked up. Built " +
        "for Thai documents (receipts, tax invoices, forms, IDs) and fine on English ones. Use ocr_document " +
        "instead for a document's full text. Returns a status line, the fields as JSON (null where a value is not " +
        "printed), then the missing, unverified, truncated, and assumed fields. Costs 13 credits per " +
        "page for a schema of up to 50 leaf fields and 19.5 per page for 51 to 100; the page reading and the " +
        "evidence spans cost nothing extra. A schema the API refuses costs nothing and names the field and reason. " +
        "The schema parameter summarizes the dialect; https://paxalabs.com/docs/extraction has every type and key.",
      inputSchema: {
        file_path: z.string().describe("Path to a local PDF, PNG, JPEG, or WebP file"),
        schema: z
          .object({ fields: z.record(z.string(), z.unknown()) })
          .describe(
            "Prefer the most specific type for each field: a specific type verifies the printed value (a date must " +
              "parse, a thai_id must pass its check digit, a bank must be a real bank) and returns a normalized form, " +
              'while "string" only copies text. Give each field a short "description" of what it is on the page. ' +
              'Example: {"fields":{"seller":{"type":"string","required":true,"description":"Shop name as printed at the top"},' +
              '"total":{"type":"number","required":true},"issued_on":{"type":"date"},"tax_id":{"type":"thai_id"},' +
              '"items":{"type":"array","max_items":10,"items":{"type":"object","fields":{"name":{"type":"string"},' +
              '"amount":{"type":"number"}}}}}}. ' +
              'Shape: {"fields": {name: definition, ...}}. A definition has "type", optional "required" (boolean), optional ' +
              '"description" (up to 200 chars, the one piece of prose the model reads: put the field\'s meaning there, ' +
              'e.g. "Seller name as printed at the top"), plus the keys its type offers. Leaf types: string (pattern, ' +
              "min_length, max_length), integer and number (min, max, decimals), date (returned as YYYY-MM-DD; min, max, " +
              "not_future, year: recent|strict|be|ce), time, enum (values 1 to 50, aliases, strict; the only field that " +
              "may be a judgment, such as the kind of document), id (digits, check: none|thai_mod11|luhn), thai_id, " +
              "email, phone (format e164|national), postal_code, province, bank, insurer, card_scheme, payment_method, " +
              "legal_form, currency, unit (closed sets with a format key), amount_words. Containers: object (fields) and " +
              "array (items: a leaf or an object, and a required max_items 1 to 200; no array inside an array). At most " +
              "3 containers below the root. Names are 1 to 64 letters, digits, and underscores. The leaf count is every " +
              "leaf once plus each array's leaves once per element it is sized for, up to 100. Full reference for every " +
              "type and its keys, with worked examples: https://paxalabs.com/docs/extraction (Markdown at " +
              "https://paxalabs.com/docs/extraction.md).",
          ),
        include_pages: z.boolean().optional().describe("Also return each page's text as Markdown, the reading the fields came from. Free."),
        include_evidence: z.boolean().optional().describe("Also return, per field path, the printed span the value was read from. Free."),
        output_path: z
          .string()
          .optional()
          .describe(
            "Save the full JSON response here. Relative paths resolve against PAXA_OUTPUT_DIR (or the working directory). An existing file is never overwritten.",
          ),
      },
    },
    async ({ file_path, schema, include_pages, include_evidence, output_path }) => {
      try {
        const path = resolve(file_path);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) return failure(`No file found at ${path}`);
        if (info.size > EXTRACT_MAX_BYTES) {
          return failure(
            `${path} is ${(info.size / 1024 / 1024).toFixed(1)} MiB; the extraction limit is 10 MiB per file.`,
          );
        }
        const ext = extname(path).toLowerCase();
        if (ext && !OCR_EXTENSIONS.has(ext)) {
          return failure(`${path} is not a supported document type (PDF, PNG, JPEG, WebP).`);
        }

        const request: ExtractRequest = { document: (await readFile(path)).toString("base64"), schema };
        if (include_pages) request.include_pages = true;
        if (include_evidence) request.include_evidence = true;
        const response = await client.extract(request);

        const parts = [
          `Status: ${response.status}. Read ${response.usage.pages} page(s) against ${response.usage.leaves} leaf ` +
            `field(s) for ${response.usage.credits} credits.` +
            (response.requestId ? ` Request id: ${response.requestId}.` : ""),
        ];
        if (output_path) {
          const given = isAbsolute(output_path) ? output_path : join(config.outputDir, output_path);
          const target = await unusedPath(dirname(given), basename(given, extname(given)), extname(given) || ".json");
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, JSON.stringify(response, null, 2) + "\n", "utf8");
          parts.push(`Saved the full response to ${target}`);
        }
        parts.push("Fields:\n" + JSON.stringify(response.fields, null, 2));
        if (response.missing.length > 0) parts.push(`Missing (required, nothing read): ${response.missing.join(", ")}`);
        if (response.unverified.length > 0) {
          parts.push(
            "Unverified (a printed span failed the field's type, delivered as null):\n" +
              response.unverified.map((u) => `- ${u.path}: ${u.reason}`).join("\n"),
          );
        }
        if (response.truncated.length > 0) {
          parts.push(`Truncated (the document had more elements; raise max_items to read them): ${response.truncated.join(", ")}`);
        }
        if (response.assumed.length > 0) {
          parts.push(
            "Assumed (two-digit years):\n" +
              response.assumed.map((a) => `- ${a.path}: printed ${a.printed}, read as ${a.read_as}`).join("\n"),
          );
        }
        const required = countRequiredFields(schema.fields);
        if (response.status === "incomplete" && required > 0 && response.missing.length * 2 >= required) {
          parts.push("Most required fields are missing: this may not be the kind of document the schema describes.");
        }
        if (response.evidence) parts.push("Evidence:\n" + JSON.stringify(response.evidence, null, 2));
        if (response.pages) {
          parts.push(response.pages.map((p) => `[page ${p.page}]\n\n${p.markdown}`).join("\n\n"));
        }
        return text(parts.join("\n\n"));
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
        "Transcribe a local recording or video of speech in Thai, English, Mandarin Chinese, or another language, " +
        "code-switching included (mp3, wav including mu-law and A-law phone recordings, flac, ogg, m4a, aac, " +
        "webm; or mp4, mov, mkv, avi and other video files, whose sound track is extracted locally with ffmpeg; " +
        "up to 120 minutes and 95 MiB) with Paxa STT. The transcript comes back inline, so nothing needs " +
        "to be read from disk afterwards; optionally it is also saved as txt, json (with word timings " +
        "and segments), srt, or vtt, named after the recording. Existing files are never overwritten. " +
        "Detects the language and can label speakers; nothing is translated. For one live answer from the " +
        "microphone, use listen instead. Terms configured in " +
        "PAXA_VOCABULARY or PAXA_VOCABULARY_FILE are pinned on every call. Costs " +
        `${STT_CREDITS_PER_MINUTE} credits per minute of audio (0.1 minimum); subtitles and word timings ` +
        "cost nothing extra. Long recordings take minutes to process.",
      inputSchema: {
        file_path: z.string().describe("Path to a local recording (mp3, wav, flac, ogg, m4a, aac, webm) or video (mp4, mov, mkv, avi, and more)"),
        pauses_over: z
          .number()
          .min(0.2)
          .max(30)
          .optional()
          .describe(
            "List every silence between words at least this many seconds long, with its start and end: the dead air to cut " +
              "when editing. 0.7 suits speech; 1.5 finds only the long gaps. Free (uses the word timings).",
          ),
        language: z
          .string()
          .max(16)
          .optional()
          .describe(STT_LANGUAGE_HINT),
        diarization: z
          .boolean()
          .optional()
          .describe("Label speakers across the whole recording (slower to return). The transcript is then returned as one line per turn, and subtitle cues never cross a speaker change."),
        style: z
          .enum(["verbatim", "clean"])
          .optional()
          .describe('"verbatim" (default) keeps fillers and false starts; "clean" drops them'),
        convention: z
          .enum(["spoken", "written"])
          .optional()
          .describe('"spoken" (default) writes numbers and dates as they were said; "written" uses numerals. Only Thai is respelled; other languages read the same under both.'),
        vocabulary: z
          .array(z.string().max(50))
          .max(50)
          .optional()
          .describe(
            "Keyword pinning: terms the recording likely contains, spelled the way they should appear in the " +
              "transcript (product names, people, places, jargon; in any language). Up to 50 terms of 50 characters. " +
              "They bias recognition and are never inserted. Added to any terms configured in PAXA_VOCABULARY or PAXA_VOCABULARY_FILE.",
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
          .describe(SUBTITLE_COLUMNS_HINT),
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
    async ({ file_path, language, diarization, style, convention, vocabulary, timestamps, pauses_over, subtitle_line_chars, save, output_dir }) => {
      let workDir: string | null = null;
      try {
        const path = resolve(file_path);
        const info = await stat(path).catch(() => null);
        if (!info?.isFile()) return failure(`No file found at ${path}`);
        const ext = extname(path).toLowerCase();
        const isVideo = VIDEO_EXTENSIONS.has(ext);
        if (ext && !isVideo && !STT_EXTENSIONS.has(ext)) {
          return failure(`${path} is not a supported recording or video type (mp3, wav, flac, ogg, m4a, aac, webm; mp4, mov, mkv, avi, mpg, 3gp, wmv, flv).`);
        }

        // A video's sound track is pulled out locally, so the size limit applies to the audio, not the video.
        let audioPath = path;
        if (isVideo) {
          if (!hasFfmpeg()) return failure(`Transcribing a video needs ffmpeg to extract its sound track. ${FFMPEG_INSTALL_HINT}`);
          workDir = await mkdtemp(join(tmpdir(), "paxa-stt-"));
          audioPath = join(workDir, "track.ogg");
          await extractAudio(path, audioPath);
        }
        const audioInfo = await stat(audioPath);
        if (audioInfo.size > STT_MAX_BYTES) {
          return failure(
            `${isVideo ? "The sound track of " : ""}${path} is ${(audioInfo.size / 1024 / 1024).toFixed(1)} MiB; the transcription limit is 95 MiB per file.`,
          );
        }

        const pinned = await pinnedVocabulary(config, vocabulary);

        const formats = new Set(save ?? []);
        const wantSrt = formats.has("srt");
        const wantVtt = formats.has("vtt");
        const request: SttRequest = { audio: await openAsBlob(audioPath) };
        if (language) request.language = language;
        if (diarization) request.diarization = true;
        if (style) request.style = style;
        if (convention) request.convention = convention;
        if (pinned.terms.length > 0) request.vocabulary = pinned.terms;
        if (timestamps || pauses_over != null || formats.has("json")) request.timestamps = "word";
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
          `Transcribed ${formatDuration(response.usage.seconds)} of audio for ${response.usage.credits} credits.` +
            (response.requestId ? ` Request id: ${response.requestId}.` : ""),
        ];
        if (pinned.terms.length > 0) {
          let line = `Pinned ${pinned.terms.length} term(s)`;
          if (pinned.fromConfig > 0) line += ` (${pinned.fromCall} from the call, ${pinned.fromConfig} from config)`;
          if (pinned.dropped > 0) line += `; ${pinned.dropped} dropped over the API's limit of ${VOCABULARY_MAX_TERMS}`;
          parts.push(line + ".");
        }
        if (written.length > 0) parts.push("Saved:\n" + written.map((f) => `- ${f}`).join("\n"));
        if (transcript.length > INLINE_TRANSCRIPT_LIMIT) {
          parts.push(transcript.slice(0, INLINE_TRANSCRIPT_LIMIT) + "\n[transcript cut here; the saved txt file has all of it]");
        } else {
          parts.push(transcript || "(no speech detected)");
        }
        if (pauses_over != null) {
          const pauses = findPauses(response.words ?? [], pauses_over);
          const shown = pauses.slice(0, 300);
          parts.push(
            `Pauses of ${pauses_over} s or more: ${pauses.length}` +
              (pauses.length > 0
                ? "\n" + shown.map((p) => `- ${p.start.toFixed(2)} to ${p.end.toFixed(2)} (${p.seconds.toFixed(2)} s)`).join("\n")
                : "") +
              (pauses.length > shown.length ? `\n[${pauses.length - shown.length} more in the json file's word timings]` : ""),
          );
        }
        if (timestamps && response.words) parts.push("Word timings:\n" + JSON.stringify(response.words));
        return text(parts.join("\n\n"));
      } catch (err) {
        return failure(err);
      } finally {
        if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  server.registerTool(
    "listen",
    {
      title: "Listen to the microphone",
      annotations: { title: "Listen to the microphone", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        "Record one spoken turn from this machine's microphone and return its transcript (Thai, English, Mandarin " +
        "Chinese, or another language, code-switching included). Paxa's realtime transcription detects when the user starts " +
        "and stops talking, so the call returns as soon as the turn ends; the audio goes straight to the API " +
        "and nothing is written to disk. Waits for any speech this server is playing to finish first. Use it " +
        "after speak when you asked the user a question and want their spoken answer; for a recording already on " +
        "disk, use transcribe_audio instead. Returns an empty " +
        "transcript when nobody spoke within wait_seconds. Costs " +
        `${LISTEN_CREDITS_PER_MINUTE} credits per minute of audio sent, silence included (a few seconds of ` +
        "listening costs well under one credit). Needs a microphone recorder on this machine (ffmpeg or sox; " +
        "parecord or arecord on Linux) and Node 22 or newer; the host app must have microphone permission.",
      inputSchema: {
        language: z
          .string()
          .max(16)
          .optional()
          .describe(STT_LANGUAGE_HINT),
        style: z
          .enum(["verbatim", "clean"])
          .optional()
          .describe('"verbatim" (default) keeps fillers and false starts; "clean" drops them'),
        convention: z
          .enum(["spoken", "written"])
          .optional()
          .describe('"spoken" (default) writes numbers as said; "written" uses numerals. Only Thai is respelled.'),
        vocabulary: z
          .array(z.string().max(50))
          .max(50)
          .optional()
          .describe("Keyword pinning, as in transcribe_audio. Added to any configured PAXA_VOCABULARY terms."),
        max_seconds: z
          .number()
          .int()
          .min(5)
          .max(300)
          .optional()
          .describe("Stop and return whatever was heard after this many seconds (default 30)"),
        wait_seconds: z
          .number()
          .int()
          .min(3)
          .max(120)
          .optional()
          .describe("Give up when nobody has started speaking after this many seconds (default 15)"),
      },
    },
    async ({ language, style, convention, vocabulary, max_seconds, wait_seconds }) => {
      try {
        await client.authToken(); // fail now, before the wait, when there is no key and no sign-in
        if (!realtimeSupported()) {
          return failure("Listening needs Node 22 or newer (its built-in WebSocket). This server runs on an older Node.");
        }
        if (!findRecorder()) return failure(noRecorderMessage());
        const pinned = await pinnedVocabulary(config, vocabulary);

        // Do not listen while this machine is still talking: wait for the queue to drain, up to a minute.
        const waitUntil = Date.now() + 60_000;
        while (engine.status().state !== "idle" && Date.now() < waitUntil) {
          await new Promise((r) => setTimeout(r, 100));
        }

        const result = await listenOnce({
          baseUrl: config.baseUrl,
          apiKey: await client.authToken(),
          language,
          style,
          convention,
          vocabulary: pinned.terms,
          maxSeconds: max_seconds ?? 30,
          waitSeconds: wait_seconds ?? 15,
          device: config.micDevice,
          isSpeaking: () => engine.status().state !== "idle",
        });

        const parts: string[] = [];
        if (result.text) {
          const speech = result.speechSeconds !== null ? `${result.speechSeconds.toFixed(1)} s of speech` : "one turn";
          const how = result.endedBy === "max_seconds" ? ", cut at max_seconds" : "";
          parts.push(`Heard (${speech}${how}, ${result.credits.toFixed(2)} credits): ${result.text}`);
        } else if (result.endedBy === "no_speech") {
          parts.push(`Nobody spoke within the wait time (${result.audioSeconds.toFixed(1)} s listened, ${result.credits.toFixed(2)} credits).`);
        } else {
          parts.push(`The turn held no speech the model could read (${result.credits.toFixed(2)} credits).`);
        }
        if (pinned.terms.length > 0) parts.push(`Pinned ${pinned.terms.length} term(s).`);
        if (result.connection) parts.push(`Connection id: ${result.connection} (use it with send_feedback).`);
        return text(parts.join("\n"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "send_feedback",
    {
      title: "Send feedback to Paxa",
      annotations: { title: "Send feedback to Paxa", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      description:
        "Report a wrong or poor output, an API problem, or a platform issue to the Paxa Labs team, tied to the " +
        "request ids the other tools print (\"Request id: ...\"). A rating alone on at least one request id is a " +
        "complete report. For a wrong output, add an example with the exact input, the output received, and the " +
        "output expected. Returns the report's id once it is filed. Free, no credits. Use it when the user says " +
        "an output was wrong, or asks to report a " +
        "problem; do not file reports the user did not ask for.",
      inputSchema: {
        kind: z
          .enum(["model", "api", "platform", "other"])
          .describe('"model" for a wrong or poor output, "api" when the API misbehaved, "platform" for dashboard, billing, or docs, else "other"'),
        rating: z.enum(["good", "bad"]).optional().describe("Judgment of the output the request ids name"),
        message: z.string().max(10_000).optional().describe("What happened and what was expected, plain text or Markdown"),
        request_ids: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Up to 20 request ids from earlier tool results, or a live session's connection id"),
        example: z
          .object({
            input: z.string().max(10_000).optional(),
            output: z.string().max(10_000).optional(),
            expected: z.string().max(10_000).optional(),
          })
          .optional()
          .describe("A worked case: the exact input, the output received, and the output expected"),
      },
    },
    async ({ kind, rating, message, request_ids, example }) => {
      try {
        if (!rating && !message && !example) {
          return failure("A report needs a rating (with at least one request id), a message, or an example.");
        }
        if (rating && !message && !example && (!request_ids || request_ids.length === 0)) {
          return failure("A rating alone needs at least one request id to rate.");
        }
        const request: FeedbackRequest = { kind };
        if (rating) request.rating = rating;
        if (message) request.message = message;
        if (request_ids && request_ids.length > 0) request.request_ids = request_ids;
        if (example) request.example = example;
        const response = await client.feedback(request);
        return text(
          `Feedback sent (report ${response.id}, ${response.kind}${response.rating ? `, rated ${response.rating}` : ""}, ` +
            `status ${response.status}). The team's note, when there is one, shows at https://paxalabs.com/app.`,
        );
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
      description:
        "List the Paxa TTS voices in one response (no paging): recommended voices first, the account's designed " +
        "voices with their slots, then the catalog roster per model with ids, names, gender, language, and " +
        "character notes. Call it when the user asks what voices exist or wants a different one, and before " +
        "save_voice to see free slots; pass an id from it as voice to speak, queue_speech, or text_to_speech. The " +
        "default voice needs no lookup. Free.",
      inputSchema: {},
    },
    async () => {
      try {
        const [voices, designed] = await Promise.all([
          client.voices(),
          client.designedVoices().catch((err: unknown) => (err instanceof PaxaApiError ? err.display() : String(err))),
        ]);
        let own: string;
        if (typeof designed === "string") {
          own = `## Your designed voices: could not be listed. ${designed}`;
        } else {
          const head =
            `## Your designed voices: ${designed.slots.used} of ${designed.slots.limit} slots in use. They speak only on ` +
            `paxa-tts-flash-v2, only for this account, at ${TTS_DESIGNED_RATE} credits per 1000 characters.`;
          own =
            designed.voices.length === 0
              ? `${head} None saved yet; design_voice makes one.`
              : `${head}\n` +
                designed.voices
                  .map((v) => `- ${v.id}: ${designedVoiceSummary(v)}` + (v.created_at ? ` Saved ${String(v.created_at).slice(0, 10)}.` : ""))
                  .join("\n");
        }
        const pending = drafts.list();
        if (pending) own += `\nUnsaved drafts in this session: ${pending}. save_voice keeps one.`;
        // The API lists a voice once per model that serves it; group them so the agent sees two rosters, not duplicates.
        const byModel = new Map<string, typeof voices>();
        for (const v of voices) byModel.set(v.model, [...(byModel.get(v.model) ?? []), v]);
        const ordered = [...byModel.keys()].sort((a, b) => (a === config.ttsModel ? -1 : b === config.ttsModel ? 1 : a.localeCompare(b)));
        const ids = (model: string) => new Set((byModel.get(model) ?? []).map((v) => v.id));
        const sections = ordered.map((model) => {
          const list = byModel.get(model) ?? [];
          const others = ordered.filter((m) => m !== model);
          const onlyHere = list.filter((v) => others.every((m) => !ids(m).has(v.id))).map((v) => v.id);
          const lines = list.map((v) => {
            const traits = [v.name, v.gender, v.language, v.accent ? `${v.accent} accent` : null].filter(Boolean).join(", ");
            const tags =
              v.emotion_tags && v.emotion_tags.length > 0
                ? ` [experimental, reads emotion tags: ${v.emotion_tags.map((t) => `[${t}]`).join(" ")}]`
                : v.experimental
                  ? " [experimental]"
                  : "";
            return `- ${v.id} (${traits}): ${v.description ?? "no description"}${tags}`;
          });
          const head =
            `## ${model}${model === config.ttsModel ? " (default)" : ""}: ${list.length} voices` +
            (model === "paxa-tts-flash-v2"
              ? ". Each speaks Thai, English, and Mandarin Chinese, and every one reads direction tags (see the speech tools)."
              : ". Legacy roster: one language per voice, regional Thai accents where noted, emotion tags on the experimental voices.") +
            (onlyHere.length > 0 ? ` Only on this model: ${onlyHere.join(", ")}.` : "");
          return `${head}\n${lines.join("\n")}`;
        });
        return text(
          `Default voice: ${config.defaultVoice}. Default model: ${config.ttsModel} (PAXA_TTS_MODEL, or the model parameter per call). ` +
            `${VOICE_PICKS} ${VOICE_GUIDANCE}\n\n${own}\n\n${sections.join("\n\n")}`,
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
      description:
        "List the available Paxa models (speech, transcription, realtime transcription, translation, OCR, and " +
        "extraction) with their limits and credit pricing, and the languages translate writes. Call it to check " +
        "a limit or a price before a large job; voices are in list_voices, and the credit balance in get_account. " +
        "Free.",
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
          if (m.large_schema_credits_per_page != null && m.large_schema_min_leaves != null) {
            facts.push(`${m.large_schema_credits_per_page} credits per page from ${m.large_schema_min_leaves} leaf fields`);
          }
          if (m.max_leaves != null) facts.push(`up to ${m.max_leaves} leaf fields per schema`);
          if (m.credits_per_hour != null) {
            facts.push(`${m.credits_per_hour} credits per hour of audio (${(m.credits_per_hour / 60).toFixed(2)} per minute)`);
          }
          if (m.min_request_credits != null) facts.push(`minimum ${m.min_request_credits} credits per request`);
          if (m.max_chars != null) facts.push(`up to ${m.max_chars} chars per request`);
          if (m.max_pages != null) facts.push(`up to ${m.max_pages} pages`);
          if (m.max_duration_seconds != null) facts.push(`up to ${Math.round(m.max_duration_seconds / 60)} minutes of audio`);
          if (m.max_session_seconds != null) facts.push(`up to ${Math.round(m.max_session_seconds / 60)} minutes per realtime connection`);
          if (m.encodings && m.encodings.length > 0) {
            facts.push(`audio in: ${m.encodings.map((e) => `${e.encoding} at ${e.sample_rates.join(" or ")} Hz`).join(", ")}`);
          }
          if (m.diarization_limit_seconds != null) {
            facts.push(`speaker labels for recordings under ${Math.round(m.diarization_limit_seconds / 60)} minutes`);
          }
          if (m.max_bytes != null) facts.push(`up to ${Math.round(m.max_bytes / 1024 / 1024)} MiB`);
          if (m.voices.length > 0) facts.push(`${m.voices.length} voices`);
          if (m.sources) facts.push(`sources: ${m.sources.join(", ")} or auto`);
          if (m.targets && m.targets.length > 0) facts.push(`targets: ${m.targets.join(", ")}` + (m.target ? ` (default ${m.target})` : ""));
          else if (m.target) facts.push(`target: ${m.target}`);
          return `- ${m.id} (${m.name}): ${facts.join("; ")}`;
        });
        return text(lines.join("\n"));
      } catch (err) {
        return failure(err);
      }
    },
  );

  // One sign-in at a time: a call while the user is still approving waits on the code already shown, and calls
  // run in turn, so two at once cannot open two codes.
  type SignInAttempt = { login: DeviceLogin; opened: boolean; done: Promise<void>; outcome?: StoredAuth | Error };
  let pendingSignIn: SignInAttempt | undefined;
  let signInTurn: Promise<unknown> = Promise.resolve();

  async function signInStep(waitSeconds: number | undefined): Promise<CallToolResult> {
    try {
      if (config.apiKey) {
        return text(
          "This server uses the API key in PAXA_API_KEY, so it needs no sign-in. To sign in instead, the user " +
            "removes PAXA_API_KEY from the server's configuration and restarts it.",
        );
      }
      if (config.baseUrl !== SIGN_IN_API) {
        return failure(
          `A sign-in works with the Paxa API at ${SIGN_IN_API} only, and PAXA_BASE_URL is ${config.baseUrl}. ` +
            "Set PAXA_API_KEY to a key for that API instead.",
        );
      }
      if (!pendingSignIn) {
        const current = await verifiedSignIn(() => client.me());
        if (current) {
          return text(
            `Already signed in${current.email ? ` as ${current.email}` : ""}; every Paxa tool is ready. To switch ` +
              "accounts, the user runs `npx -y @paxalabs/mcp logout` in a terminal, then you call sign_in again.",
          );
        }
        const login = await startDeviceLogin();
        const entry: SignInAttempt = { login, opened: await openInBrowser(login.url), done: Promise.resolve() };
        entry.done = finishDeviceLogin(login, true).then(
          (auth) => {
            entry.outcome = auth;
            // Approved between calls: the next call checks the stored sign-in instead of replaying this result.
            if (pendingSignIn === entry) pendingSignIn = undefined;
          },
          (err: unknown) => {
            entry.outcome = err instanceof Error ? err : new Error(String(err));
          },
        );
        pendingSignIn = entry;
        if (!entry.opened) {
          return text(
            `No browser opened on this machine. Ask the user to open ${login.url} and approve the request there; ` +
              `the page shows the code ${login.userCode}. Then call sign_in again to finish (the code expires in 30 minutes).`,
          );
        }
      }
      const entry = pendingSignIn;
      // Past the code's expiry, wait one more poll so the expiry is reported instead of "still waiting".
      const waitMs = Math.min((waitSeconds ?? 50) * 1000, Math.max(0, entry.login.expiresAt - Date.now()) + entry.login.intervalMs + 1000);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([entry.done, new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))]);
      clearTimeout(timer);
      const { login, outcome } = entry;
      if (outcome === undefined) {
        const minutes = Math.max(1, Math.ceil((login.expiresAt - Date.now()) / 60_000));
        return text(
          `Still waiting for the user to approve the sign-in at ${login.url} (the page shows the code ` +
            `${login.userCode}; it expires in ${minutes} minutes). ` +
            (entry.opened ? "The page opened in their browser. " : "") +
            "Call sign_in again to keep waiting.",
        );
      }
      if (pendingSignIn === entry) pendingSignIn = undefined;
      if (outcome instanceof Error) return failure(outcome);
      return text(`Signed in${outcome.email ? ` as ${outcome.email}` : ""}. Every Paxa tool is ready, in every session on this machine.`);
    } catch (err) {
      return failure(err);
    }
  }

  server.registerTool(
    "sign_in",
    {
      title: "Sign in to Paxa",
      annotations: { title: "Sign in to Paxa", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Connect this machine to the user's Paxa account when no API key is configured: opens the Paxa sign-in " +
        "page in the user's browser with a code filled in, and the user approves there (new accounts include free " +
        "credits). Every Paxa tool then works, in every session on this machine, until the user signs out or leaves " +
        "it unused for 30 days. Waits up to wait_seconds for the approval; if it has not come yet, call sign_in " +
        "again to keep waiting on the same code. When no browser opens, it returns the page and the code at once for " +
        "you to give the user. Answers at once when already signed in or when PAXA_API_KEY is set. Free.",
      inputSchema: {
        wait_seconds: z
          .number()
          .int()
          .min(0)
          .max(300)
          .optional()
          .describe(
            "How long to wait for the approval before returning (default 50). The sign-in keeps waiting in the " +
              "background either way, until its code expires after 30 minutes.",
          ),
      },
    },
    async ({ wait_seconds }) => {
      const turn = signInTurn.then(() => signInStep(wait_seconds));
      signInTurn = turn.catch(() => undefined);
      return turn;
    },
  );

  server.registerTool(
    "get_account",
    {
      title: "Account and credits",
      annotations: { title: "Account and credits", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        "Show the account behind the API key or sign-in, read from the API on each call: credit balance, spending " +
        "cap, plan, and rate limits. Call it before a large paid job, or after a call fails for credits or a rate " +
        "limit; prices per model are in list_models. Free.",
      inputSchema: {},
    },
    async () => {
      try {
        const account = await client.me();
        const email = config.apiKey ? undefined : readStoredAuth()?.email;
        const who = account.key.key_start
          ? `Key "${account.key.name ?? account.key.key_start}" (${account.key.key_start}...)`
          : `Signed in${email ? ` as ${email}` : ""} through the app "${account.key.name ?? "Paxa MCP"}"`;
        return text(
          [
            `${who}, ${account.key.credits_spent} credits spent` +
              (account.key.credit_limit != null ? `, spending cap ${account.key.credit_limit}` : ", no spending cap") +
              ".",
            `Balance: ${account.balance.total} credits (wallet ${account.balance.wallet}, plan ${account.balance.plan}).`,
            `Plan "${account.plan.key}": ${account.plan.monthly_credits} credits per month, ` +
              (account.plan.rpm == null ? "no per-minute request limit" : `${account.plan.rpm} requests per minute`) +
              ", " +
              (account.plan.concurrency == null
                ? "concurrent request limit not reported"
                : `${account.plan.concurrency} concurrent requests per product`) +
              ".",
          ].join("\n"),
        );
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}
