import { randomUUID } from "node:crypto";

import { DEFAULT_TTS_MODEL, MISSING_KEY_MESSAGE, type TtsModel } from "./config.js";

/** Used when a request names no model. Prefer passing the configured model explicitly. */
export const TTS_MODEL: TtsModel = DEFAULT_TTS_MODEL;
export const TRANSLATE_MODEL = "paxa-translation-lite-v1";
export const OCR_MODEL = "paxa-ocr-lite-v1";
export const STT_MODEL = "paxa-stt-lite-v1-preview";
export const STT_REALTIME_MODEL = "paxa-stt-lite-realtime-v1-preview";
export const EXTRACT_MODEL = "paxa-doc-extract-v1";

/** The languages Paxa Translate reads and writes, any into any other (checked live 2026-11-02). */
export const TRANSLATE_LANGUAGES = ["th", "en", "zh", "ja", "ko", "ar", "fr", "de", "hi", "id", "ms", "pt", "ru", "es", "vi"] as const;
export type TranslateLanguage = (typeof TRANSLATE_LANGUAGES)[number];

export const TTS_MAX_CHARS = 5000;
/** A streamed request takes four times the buffered ceiling, on both models (max_stream_chars on GET /v1/models). */
export const TTS_MAX_STREAM_CHARS = 20_000;
/** POST /v1/tts/dialogue: at most this many lines, holding at most this many characters in all. */
export const DIALOGUE_MAX_LINES = 100;
export const DIALOGUE_MAX_CHARS = 20_000;
export const OCR_MAX_BYTES = 10 * 1024 * 1024;
/** 95 MiB, the decoded ceiling of /v1/stt. Only a multipart upload reaches it: a JSON body caps at about 71 MiB of file. */
export const STT_MAX_BYTES = 99_614_720;
export const EXTRACT_MAX_BYTES = 10 * 1024 * 1024;

const RETRYABLE_CODES = new Set([
  "rate_limited",
  "concurrency_limited",
  "provider_error",
  "provider_unavailable",
  "idempotency_in_flight",
  "internal",
]);

const KEYS_URL = "https://paxalabs.com/app/keys";

/** What the agent should do, or tell the user, for each stable error code from the API. */
const HINTS: Record<string, string> = {
  unauthorized:
    "The API key was rejected (missing, invalid, or disabled). Ask the user to check PAXA_API_KEY " +
    `in their MCP client config (keys are managed at ${KEYS_URL}) and restart the server.`,
  insufficient_credits:
    "The account is out of credits; nothing was charged. Ask the user to top up or upgrade at " +
    "https://paxalabs.com, then retry.",
  key_limit:
    "This API key reached its spending cap; nothing was charged. Ask the user to raise or remove " +
    `the cap at ${KEYS_URL}, or configure another key.`,
  rate_limited:
    "Requests per minute for the plan are exhausted (one window across the whole account). " +
    "Wait a minute and retry, or the user can upgrade the plan.",
  concurrency_limited: "Too many requests in flight on this account. Wait for one to finish, then retry.",
  unknown_voice:
    "That voice id is not served by the model this request used. The roster differs per model: run list_voices, " +
    "and pass model \"paxa-tts-flash-v1\" for a voice that exists only there (donut, toast, padthai, yoyo, somtam, larb, khaosoi, roti). " +
    "A designed voice id (voice_...) speaks only on paxa-tts-flash-v2, only for the account that saved it, and stops once " +
    "deleted; list_voices shows the account's designed voices.",
  draft_invalid:
    "The draft did not open: it was altered or cut short, belongs to another account, or predates a platform update. " +
    "Nothing was charged. Pass the draft handle design_voice or refine_voice printed, or design the voice again.",
  voice_name_taken: "That name belongs to a catalog voice, which no designed voice can take. Nothing was saved; choose another name.",
  voice_slots_full:
    "The account holds as many designed voices as its plan allows. Nothing was saved. Ask the user whether to delete " +
    "one (delete_voice, which cannot be undone) or upgrade the plan; list_voices shows the slots in use.",
  tag_invalid:
    "The text holds a bracketed tag the model refuses; nothing was charged. On paxa-tts-flash-v2 that is a direction " +
    "the model cannot do (an accent, singing, an untrained sound), a bracket without letters, or a weight that is not " +
    "a number; on v1 it is a word outside the emotion tag list. Remove or reword the tag. " +
    "Reference: https://paxalabs.com/docs/directions",
  validation: "The request broke a rule (the field and reason above say which); nothing was charged. Fix it and retry.",
  text_too_long: "Split the text into shorter requests.",
  request_too_large:
    "For translation, shorten the text, context, instructions, examples, or glossary: every field counts toward the " +
    "request ceiling, and each rendering (alternatives) counts the text again. A dialogue's lines hold 20,000 " +
    "characters in all.",
  body_too_large: "The request body is larger than the endpoint reads; nothing was charged. Send a smaller file.",
  audio_too_long: "The recording runs over 120 minutes; nothing was charged. Split it at a pause and transcribe the parts.",
  audio_too_large: "The recording is over 95 MiB; nothing was charged. Compress it (mono Opus or mp3) or split it.",
  unsupported_language:
    "The translation model does not take that language code, or a pinned source equals the target. The codes are " +
    `${TRANSLATE_LANGUAGES.join(", ")}; leave source out to detect it.`,
  unsupported_format:
    "The model does not serve that format at that sample rate. paxa-tts-flash-v2 serves pcm and wav at 8000 to 48000 Hz " +
    "and mulaw and alaw at 8000; paxa-tts-flash-v1 serves pcm and wav at 24000 only, and no mulaw or alaw. mp3 and opus " +
    "take only their own rate. Leave sample_rate out for the format's own rate.",
  unspeakable_text:
    "The text holds nothing to voice: only tags, emoji, punctuation, or a script the model does not speak. A text of " +
    "tags alone is refused before the charge, any other is refunded. Write Thai, English, or Mandarin Chinese words; " +
    "retrying the same text fails again.",
  content_blocked:
    "The safety system declined this content; the charge was refunded. Revise the input, " +
    "retrying the same content fails again. If the block looks wrong, contact support with the request id.",
  document_invalid: "The file could not be read as a PDF, PNG, JPEG, or WebP; nothing was charged.",
  document_password_required:
    "The PDF needs a password to open; nothing was charged. Use a copy that opens without a password.",
  too_many_pages:
    "The document has more pages than the model accepts (50 for OCR, 20 for extraction); nothing was charged. Split it.",
  schema_invalid:
    "The extraction schema is outside the dialect; nothing was charged. Fix the named field, and see " +
    "https://paxalabs.com/docs/extraction for every type and its keys.",
  document_too_large: "The document exceeds the size limit (10 MiB); nothing was charged. Compress or split it.",
  provider_error: "The upstream model failed; the charge was refunded. Retry.",
  provider_unavailable: "The model is unavailable right now; nothing was charged. Retry later.",
  internal: "Retry. If it keeps failing, report the request id to Paxa support.",
};

/** Fallback when the body carried no code (for example a proxy error page). */
const STATUS_FALLBACK: Record<number, string> = {
  401: "unauthorized",
  402: "insufficient_credits",
  403: "key_limit",
  429: "rate_limited",
};

function hintFor(code: string, status: number): string | undefined {
  const byCode = HINTS[code];
  if (byCode) return byCode;
  const fallback = STATUS_FALLBACK[status];
  if (fallback) return HINTS[fallback];
  if (status >= 500) return "Retry later. If it keeps failing, report the request id to Paxa support.";
  return undefined;
}

export class PaxaApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly requestId: string | undefined,
    detail?: string,
    /**
     * Where a refused request went wrong: the field path in dot form (body.temperature, or a field of an extraction
     * schema, empty for the schema's root) and a stable reason code. Validation errors and refused schemas carry it.
     */
    readonly problem?: { path: string; reason: string },
  ) {
    super(detail && detail.length > 0 ? detail : code);
  }

  /** The 0-based line of a dialogue script the error names. A caller that split the script maps it to the whole. */
  line?: number;

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  display(): string {
    let out = `Paxa API error "${this.code}" (HTTP ${this.status})`;
    if (this.message !== this.code) out += `: ${this.message}`;
    if (this.requestId) out += ` [request id ${this.requestId}]`;
    out += ".";
    if (this.problem) {
      const { path, reason } = this.problem;
      if (path) out += ` The problem is at field "${path}": ${reason}.`;
      else if (this.code === "schema_invalid") out += ` The problem is at the schema root: ${reason}.`;
      else out += ` Reason: ${reason}.`;
    }
    if (this.line !== undefined) out += ` The problem is in line ${this.line + 1} of the script.`;
    const hint = hintFor(this.code, this.status);
    if (hint) out += ` ${hint}`;
    else if (this.retryable) out += " This error is retryable.";
    return out;
  }
}

/** RFC 9457 problem details as the API sends them, on an error response or inside a stream's error event. */
interface ProblemBody {
  title?: string;
  status?: number;
  detail?: string;
  path?: string;
  reason?: string;
  line?: number;
}

function problemError(body: ProblemBody, status: number, requestId: string | undefined): PaxaApiError {
  const problem = typeof body.reason === "string" ? { path: typeof body.path === "string" ? body.path : "", reason: body.reason } : undefined;
  const err = new PaxaApiError(body.title ?? "unknown", body.status ?? status, requestId, body.detail, problem);
  if (typeof body.line === "number") err.line = body.line;
  return err;
}

/** Why a stream that broke off failed. A cut raw stream has no end marker: the API aborts the connection instead. */
export function streamCutMessage(err: unknown): string {
  const why = err instanceof Error ? err.message : String(err);
  return (
    `The audio stream ended early (${why}). The API refunds a stream that fails partway, and does not charge one ` +
    "it refuses partway (out of credits, or the key's spending cap), so check the balance if it repeats."
  );
}

/**
 * Why an NDJSON stream that broke off failed. A failure or refusal there ends with an error event, so a stream with
 * neither done nor error ran out of the request's time or lost its connection, and the API keeps that charge.
 */
export function eventStreamCutMessage(err: unknown): string {
  const why = err instanceof Error ? err.message : String(err);
  return (
    `The stream broke off before its end (${why}), with no error event, so the API keeps its charge. Retry; if it ` +
    "repeats, report the request id with send_feedback."
  );
}

/** The JSON events of an NDJSON body, one per line. A body that breaks off, even partway through a line, throws. */
async function* ndjsonEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for await (const chunk of body) {
      pending += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) yield JSON.parse(line) as Record<string, unknown>;
      }
    }
    pending += decoder.decode();
    if (pending.trim()) yield JSON.parse(pending) as Record<string, unknown>;
  } catch (err) {
    throw new Error(eventStreamCutMessage(err));
  }
}

export const AUDIO_FORMATS = ["mp3", "opus", "wav", "pcm", "mulaw", "alaw"] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];
export type RawFormat = "pcm" | "mulaw" | "alaw";

/** Headerless sample formats: pcm is 16-bit little-endian mono, mulaw and alaw are G.711 at one byte per sample. */
export function isRawFormat(format: AudioFormat): format is RawFormat {
  return format === "pcm" || format === "mulaw" || format === "alaw";
}
/** The rates pcm and wav can be asked for; v1 serves 24000 only, mulaw and alaw are always 8000. */
export const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100, 48000] as const;
export type SampleRate = (typeof SAMPLE_RATES)[number];

export type TtsLanguage = "auto" | "th" | "en" | "zh";

export interface TtsRequest {
  text: string;
  voice: string;
  format?: AudioFormat;
  /** Sample rate of pcm and wav, in Hz. */
  sample_rate?: SampleRate;
  model?: string;
  /** How codes, digits, and symbols are read. "auto" (the default) works it out from the text. */
  language?: TtsLanguage;
  /** Speaking rate, 0.5 to 1.5, as a multiplier on the voice's design speed. Pitch is preserved; the price is the same. */
  speed?: number;
  /** How much a reading varies from one request to the next, 0 to 2 (default 0.5). v2 only; v1 refuses any other value. */
  temperature?: number;
}

/** One timing span of synthesized speech, in seconds from the start of the response's audio. */
export interface TtsSpan {
  text: string;
  start: number;
  end: number;
}

export interface DialogueLine {
  text: string;
  voice: string;
}

export interface DialogueRequest extends Omit<TtsRequest, "text" | "voice"> {
  lines: DialogueLine[];
  /** Silence between one line and the next, 0 to 5000 ms (default 300). */
  gap_ms?: number;
  timestamps?: "word";
}

/** What a dialogue request delivered. Without failure every line arrived; with one, the lines delivered whole. */
export interface DialogueOutcome {
  /** The audio of the lines delivered whole, in the requested format. */
  audio: Buffer;
  /** How many lines arrived whole: all of them unless failure is set. */
  whole: number;
  /** Each whole line's place in the audio. Empty when the stream broke off with no event to say. */
  lines: Array<{ start: number; end: number }>;
  /** Word spans of the whole lines, measured from the start of this request's audio. */
  spans: Array<TtsSpan & { line: number }>;
  /** Credits the request kept: the charge, or what the whole lines cost when it failed. */
  credits: number | undefined;
  requestId: string | undefined;
  failure?: Error;
}

/** Per-request synthesis settings shared by the speech tools and the engine. */
export interface SpeechOptions {
  model?: TtsModel;
  language?: TtsLanguage;
  speed?: number;
  temperature?: number;
}

export interface Voice {
  id: string;
  name: string;
  gender: string | null;
  language: string | null;
  accent: string | null;
  /** An experimental voice keeps its id while its delivery is still being tuned. */
  experimental?: boolean;
  /** Bracketed tags such as [happy] the voice reads from the text; empty for a voice that skips them. */
  emotion_tags?: string[];
  description: string | null;
  model: string;
}

/** The words that describe a designed voice, as the design, save, list, and rename endpoints return them. */
export interface DesignedVoiceWords {
  name: string;
  /** Who the voice is, in a few words. */
  role: string;
  /** How the voice sounds, in one sentence. */
  description: string;
  gender: "f" | "m";
  /** The one language the voice was designed to speak. */
  language: "th" | "en" | "zh";
  model: string;
}

/** A voice saved to the account. Its id (voice_...) is what the voice field of a v2 speech request accepts. */
export interface DesignedVoice extends DesignedVoiceWords {
  id: string;
  created_at: string;
}

export interface VoiceDesignRequest {
  /** Who the voice is and how it sounds, 1 to 1000 characters. Sent alone, for a new voice. */
  description?: string;
  /** A draft an earlier design returned, sent with an instruction to refine it. */
  draft?: string;
  /** What to change about the draft's voice, 1 to 500 characters. */
  instruction?: string;
}

export interface VoiceDesignResponse {
  /** The voice, sealed for this account: send it back to refine, or save it. */
  draft: string;
  voice: DesignedVoiceWords & { line: string };
  /** The example line spoken in the voice, as base64 MP3. */
  audio: string;
  usage: { credits: number };
}

export interface DesignedVoiceList {
  voices: DesignedVoice[];
  slots: { used: number; limit: number };
}

/** Set on every JSON response so a tool can quote it, and send_feedback can point at it. */
export interface WithRequestId {
  requestId?: string;
}

export type FeedbackKind = "model" | "api" | "platform" | "other";

export interface FeedbackRequest {
  kind: FeedbackKind;
  rating?: "good" | "bad";
  message?: string;
  request_ids?: string[];
  example?: { input?: string; output?: string; expected?: string };
}

export interface FeedbackResponse {
  id: string;
  kind: FeedbackKind;
  rating: "good" | "bad" | null;
  status: "open" | "resolved";
  resolution: string | null;
  created_at: string;
}

export interface PaxaModel {
  id: string;
  name: string;
  product: "tts" | "translation" | "ocr" | "stt" | "extraction";
  max_chars: number | null;
  max_request_chars: number | null;
  credits_per_1k_chars: number | null;
  reference_credits_per_1k_chars: number | null;
  credits_per_page: number | null;
  large_schema_credits_per_page: number | null;
  large_schema_min_leaves: number | null;
  max_leaves: number | null;
  credits_per_hour: number | null;
  max_pages: number | null;
  max_duration_seconds: number | null;
  diarization_limit_seconds: number | null;
  /** Most audio one realtime connection accepts, in seconds. */
  max_session_seconds?: number | null;
  /** Audio a realtime connection's start frame may declare. */
  encodings?: Array<{ encoding: string; sample_rates: number[] }> | null;
  max_bytes: number | null;
  formats: string[] | null;
  min_request_credits: number | null;
  voices: string[];
  sources: string[] | null;
  /** The languages a translation model writes. */
  targets?: string[] | null;
  /** The language an omitted target reads as. */
  target: string | null;
}

export interface TranslateRequest {
  text: string | string[];
  model?: string;
  /** Pinned source language; "auto" (the default) detects it per segment. */
  source?: TranslateLanguage | "auto";
  /** The language to write; the API reads an omitted target as Thai. */
  target?: TranslateLanguage;
  formality?: "auto" | "formal" | "casual";
  borrowed_words?: "auto" | "transliterate" | "preserve";
  format?: "text" | "markdown" | "html";
  /** Renderings per segment, 1 to 5; each bills the text again. */
  alternatives?: number;
  instructions?: string;
  context?: string;
  examples?: Array<{ source: string; target: string }>;
  do_not_translate?: string[];
  glossary?: Array<{ source: string; target: string; always?: boolean }>;
}

export interface TranslateResponse {
  translations: Array<{
    text: string;
    detected_source?: string;
    /** Further renderings, best first, when alternatives was above 1. */
    alternatives?: string[];
    review?: { reason: string; detail?: string } | null;
  }>;
  usage: {
    text_chars: number;
    reference_chars: number;
    billable_chars: number;
    credits: number;
    glossary_terms_sent?: number;
    glossary_terms_available?: number;
  };
}

export interface OcrRequest {
  document: string;
  model?: string;
  output?: "markdown" | "structured";
}

export interface SttRequest {
  /** The recording, sent as a multipart file part (openAsBlob reads it from disk); the API reads format and length from it. */
  audio: Blob;
  model?: string;
  language?: string;
  timestamps?: "word";
  subtitles?: "srt" | "vtt";
  subtitle_line_chars?: number;
  diarization?: boolean;
  style?: "verbatim" | "clean";
  convention?: "spoken" | "written";
  vocabulary?: string[];
}

export interface SttWord {
  text: string;
  start: number;
  end: number;
  speaker?: number;
}

export interface SttSegment {
  speaker?: number;
  text: string;
  start: number;
  end: number;
}

export interface SttResponse {
  text: string;
  words?: SttWord[];
  segments?: SttSegment[];
  /** The rendered subtitle file, present when the request asked for one. */
  subtitles?: string;
  usage: { seconds: number; credits: number };
}

/** The extraction schema dialect, written by the caller and validated by the API. */
export interface ExtractSchema {
  fields: Record<string, unknown>;
}

export interface ExtractRequest {
  /** Base64 of a PDF, PNG, JPEG, or WebP file. */
  document: string;
  model?: string;
  schema: ExtractSchema;
  include_pages?: boolean;
  include_evidence?: boolean;
}

export interface ExtractResponse {
  status: "complete" | "incomplete";
  fields: Record<string, unknown>;
  missing: string[];
  unverified: Array<{ path: string; reason: string }>;
  truncated: string[];
  assumed: Array<{ path: string; printed: string; read_as: number }>;
  evidence?: Record<string, string>;
  pages?: Array<{ page: number; markdown: string }>;
  usage: { pages: number; leaves: number; credits: number };
}

export interface OcrResponse {
  pages: Array<{
    page: number;
    markdown?: string;
    blocks?: unknown[];
  }>;
  usage: { pages: number; credits: number };
}

export interface AccountInfo {
  key: {
    id: string;
    name: string | null;
    key_start: string;
    credit_limit: number | null;
    credits_spent: number;
    created_at: string;
    last_used_at: string | null;
  };
  balance: { wallet: number; plan: number; total: number };
  /** rpm null means no per-minute limit. concurrency is documented as an integer, but may be null. */
  plan: { key: string; rpm: number | null; concurrency: number | null; monthly_credits: number };
}

/** A signal that aborts when either input aborts. */
function eitherSignal(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const controller = new AbortController();
  for (const signal of [a, b]) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export class PaxaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
  ) {}

  private async request(
    path: string,
    init: {
      method?: string;
      /** JSON-encoded, except FormData, which goes as multipart with fetch's own boundary. */
      body?: unknown;
      idempotent?: boolean;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<Response> {
    if (!this.apiKey) throw new Error(MISSING_KEY_MESSAGE);
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
    };
    const multipart = init.body instanceof FormData;
    if (init.body !== undefined && !multipart) headers["content-type"] = "application/json";
    if (init.idempotent) headers["idempotency-key"] = randomUUID();

    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : multipart ? (init.body as FormData) : JSON.stringify(init.body),
        signal: eitherSignal(init.signal, AbortSignal.timeout(init.timeoutMs ?? 60_000)),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Could not reach the Paxa API at ${this.baseUrl}: ${cause}. Check this machine's internet ` +
          "connection, and PAXA_BASE_URL if it is set (the default is https://api.paxalabs.com).",
      );
    }

    if (!res.ok) {
      const requestId = res.headers.get("x-request-id") ?? undefined;
      if ((res.headers.get("content-type") ?? "").includes("json")) {
        const body = (await res.json().catch(() => undefined)) as ProblemBody | undefined;
        if (body) throw problemError(body, res.status, requestId);
      }
      throw new PaxaApiError("unknown", res.status, requestId);
    }
    return res;
  }

  async tts(req: TtsRequest): Promise<Buffer> {
    const res = await this.request("/v1/tts", {
      method: "POST",
      body: { model: TTS_MODEL, format: "mp3", ...req, stream: false },
      idempotent: true,
      timeoutMs: 120_000,
    });
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Streaming synthesis. Resolves as soon as the response headers arrive; audio
   * chunks then follow on the body while synthesis is still running. A failure
   * after the first byte, or a refusal after it (out of credits, the key's cap),
   * aborts the connection, so reading the body throws; the API refunds the first
   * and does not charge the second. No other end signal exists on a raw stream.
   */
  async ttsStream(req: TtsRequest, signal?: AbortSignal, timeoutMs = 120_000): Promise<ReadableStream<Uint8Array>> {
    const res = await this.request("/v1/tts", {
      method: "POST",
      body: { model: TTS_MODEL, format: "mp3", ...req, stream: true },
      idempotent: true,
      timeoutMs,
      signal,
    });
    if (!res.body) throw new Error("The Paxa API returned an empty audio stream.");
    return res.body;
  }

  /** Synthesize up to TTS_MAX_STREAM_CHARS into memory over a stream. A stream that breaks off throws streamCutMessage. */
  async ttsWhole(req: TtsRequest): Promise<Buffer> {
    const body = await this.ttsStream(req, undefined, 900_000);
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of body) chunks.push(Buffer.from(chunk));
    } catch (err) {
      throw new Error(streamCutMessage(err));
    }
    return Buffer.concat(chunks);
  }

  /** Like ttsWhole, with word timings from the NDJSON stream, whose done and error events say how it ended. Bills 1.25x. */
  async ttsWholeTimed(req: TtsRequest): Promise<{ audio: Buffer; spans: TtsSpan[] }> {
    const res = await this.request("/v1/tts", {
      method: "POST",
      body: { model: TTS_MODEL, format: "mp3", ...req, stream: true, timestamps: "word" },
      idempotent: true,
      timeoutMs: 900_000,
    });
    const requestId = res.headers.get("x-request-id") ?? undefined;
    if (!res.body) throw new Error("The Paxa API returned an empty audio stream.");
    const audio: Buffer[] = [];
    const spans: TtsSpan[] = [];
    for await (const event of ndjsonEvents(res.body)) {
      if (event.type === "chunk") {
        if (typeof event.audio === "string" && event.audio) audio.push(Buffer.from(event.audio, "base64"));
        spans.push(...((event.spans as TtsSpan[] | undefined) ?? []));
      } else if (event.type === "done") {
        return { audio: Buffer.concat(audio), spans };
      } else if (event.type === "error") {
        throw problemError((event.error ?? {}) as ProblemBody, res.status, requestId);
      }
    }
    throw new Error(eventStreamCutMessage("the stream closed with no done event"));
  }

  /**
   * Speak a script of lines, each in its own voice, as one audio file (POST /v1/tts/dialogue, always NDJSON).
   * Lines arrive in order, so when the stream fails or breaks off, every line below the one in flight is whole;
   * the outcome keeps those, which the request paid for, instead of throwing them away.
   */
  async dialogue(req: DialogueRequest): Promise<DialogueOutcome> {
    const res = await this.request("/v1/tts/dialogue", {
      method: "POST",
      body: { model: TTS_MODEL, format: "mp3", ...req },
      idempotent: true,
      timeoutMs: 900_000,
    });
    const requestId = res.headers.get("x-request-id") ?? undefined;
    const charged = Number.parseFloat(res.headers.get("x-credits-charged") ?? "");
    const perLine: Buffer[][] = [];
    const spans: Array<TtsSpan & { line: number }> = [];
    let lastLine = -1;
    const outcome = (whole: number, lines: DialogueOutcome["lines"], credits: number | undefined, failure?: Error): DialogueOutcome => ({
      audio: Buffer.concat(perLine.slice(0, whole).flat()),
      whole,
      lines: lines.slice(0, whole),
      spans: spans.filter((span) => span.line < whole),
      credits,
      requestId,
      ...(failure ? { failure } : {}),
    });
    if (!res.body) throw new Error("The Paxa API returned an empty audio stream.");
    try {
      for await (const event of ndjsonEvents(res.body)) {
        if (event.type === "chunk") {
          const line = Number(event.line);
          lastLine = Math.max(lastLine, line);
          if (typeof event.audio === "string" && event.audio) (perLine[line] ??= []).push(Buffer.from(event.audio, "base64"));
          for (const span of (event.spans as TtsSpan[] | undefined) ?? []) spans.push({ ...span, line });
        } else if (event.type === "done") {
          const lines = event.lines as DialogueOutcome["lines"];
          return outcome(lines.length, lines, Number.isFinite(charged) ? charged : undefined);
        } else if (event.type === "error") {
          const lines = (event.lines as DialogueOutcome["lines"] | undefined) ?? [];
          const credits = typeof event.credits === "number" ? event.credits : undefined;
          return outcome(lines.length, lines, credits, problemError((event.error ?? {}) as ProblemBody, res.status, requestId));
        }
      }
      throw new Error(eventStreamCutMessage("the stream closed with no done event"));
    } catch (err) {
      // Broke off with no event: the charge stands, and the lines before the one in flight are whole.
      const failure = err instanceof Error ? err : new Error(String(err));
      return outcome(Math.max(0, lastLine), [], Number.isFinite(charged) ? charged : undefined, failure);
    }
  }

  /** Parse a JSON body and attach the response's x-request-id. */
  private async json<T>(res: Response): Promise<T & WithRequestId> {
    const body = (await res.json()) as T & WithRequestId;
    const id = res.headers.get("x-request-id");
    if (id) body.requestId = id;
    return body;
  }

  async translate(req: TranslateRequest): Promise<TranslateResponse & WithRequestId> {
    const res = await this.request("/v1/translate", {
      method: "POST",
      body: { model: TRANSLATE_MODEL, ...req },
      idempotent: true,
      timeoutMs: 300_000,
    });
    return this.json<TranslateResponse>(res);
  }

  /** Report a wrong output or a problem to the Paxa team. Free, no idempotency key, no credits. */
  async feedback(req: FeedbackRequest): Promise<FeedbackResponse & WithRequestId> {
    const res = await this.request("/v1/feedback", { method: "POST", body: req, timeoutMs: 60_000 });
    return this.json<FeedbackResponse>(res);
  }

  /**
   * Transcribe a recording, uploaded as multipart: no base64 inflation, so the
   * full 95 MiB fits. Long recordings take minutes (the docs allow 900 s for
   * upload and work), and the API may answer a long job with status 200 and an
   * error object, so that case is turned into a PaxaApiError here.
   */
  async stt(req: SttRequest): Promise<SttResponse & WithRequestId> {
    const { audio, vocabulary, model, ...fields } = req;
    const form = new FormData();
    form.append("model", model ?? STT_MODEL);
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(key, String(value));
    }
    for (const term of vocabulary ?? []) form.append("vocabulary", term);
    form.append("audio", audio, "audio");
    const res = await this.request("/v1/stt", {
      method: "POST",
      body: form,
      idempotent: true,
      timeoutMs: 900_000,
    });
    const body = await this.json<SttResponse & { title?: string; detail?: string }>(res);
    if (typeof body.text !== "string") {
      throw new PaxaApiError(body.title ?? "unknown", res.status, body.requestId, body.detail);
    }
    return body;
  }

  /** Fill a schema of typed fields from a document. A multi-page document can take minutes. */
  async extract(req: ExtractRequest): Promise<ExtractResponse & WithRequestId> {
    const res = await this.request("/v1/extract", {
      method: "POST",
      body: { model: EXTRACT_MODEL, ...req },
      idempotent: true,
      timeoutMs: 600_000,
    });
    return this.json<ExtractResponse>(res);
  }

  async ocr(req: OcrRequest): Promise<OcrResponse & WithRequestId> {
    const res = await this.request("/v1/ocr", {
      method: "POST",
      body: { model: OCR_MODEL, ...req },
      idempotent: true,
      timeoutMs: 300_000,
    });
    return this.json<OcrResponse>(res);
  }

  async voices(): Promise<Voice[]> {
    const res = await this.request("/v1/voices");
    return ((await res.json()) as { voices: Voice[] }).voices;
  }

  /**
   * Design a voice from a description, or refine a draft with an instruction. 5 credits a call. The endpoint
   * refuses an Idempotency-Key (a retry designs a new voice and is charged again), so none is sent.
   */
  async designVoice(req: VoiceDesignRequest): Promise<VoiceDesignResponse & WithRequestId> {
    const res = await this.request("/v1/voices/design", { method: "POST", body: req, timeoutMs: 180_000 });
    return this.json<VoiceDesignResponse>(res);
  }

  /** Save a draft as one of the account's voices. Free; saving the same draft again returns the same voice. */
  async saveVoice(req: { draft: string; name?: string }): Promise<DesignedVoice & WithRequestId> {
    const res = await this.request("/v1/voices/designed", { method: "POST", body: req });
    return this.json<DesignedVoice>(res);
  }

  /** The account's designed voices, oldest first, with the slots in use and the plan's limit. Free. */
  async designedVoices(): Promise<DesignedVoiceList> {
    const res = await this.request("/v1/voices/designed");
    return (await res.json()) as DesignedVoiceList;
  }

  async renameVoice(id: string, name: string): Promise<DesignedVoice & WithRequestId> {
    const res = await this.request(`/v1/voices/designed/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } });
    return this.json<DesignedVoice>(res);
  }

  /** Delete a designed voice and free its slot. Cannot be undone. */
  async deleteVoice(id: string): Promise<{ id: string } & WithRequestId> {
    const res = await this.request(`/v1/voices/designed/${encodeURIComponent(id)}`, { method: "DELETE" });
    return this.json<{ id: string }>(res);
  }

  async models(): Promise<PaxaModel[]> {
    const res = await this.request("/v1/models");
    return ((await res.json()) as { models: PaxaModel[] }).models;
  }

  async me(): Promise<AccountInfo> {
    const res = await this.request("/v1/me");
    return (await res.json()) as AccountInfo;
  }
}
