/** The two speech models the API serves. v2 is the default; v1 stays for its regional accents, its emotion-tag voices, and eight voices v2 does not carry. */
export const TTS_MODELS = ["paxa-tts-flash-v2", "paxa-tts-flash-v1"] as const;
export type TtsModel = (typeof TTS_MODELS)[number];
export const DEFAULT_TTS_MODEL: TtsModel = "paxa-tts-flash-v2";
/** Voices only paxa-tts-flash-v1 serves (checked live 2026-10-17); on v2 they answer unknown_voice. */
export const V1_ONLY_VOICES = ["donut", "toast", "padthai", "yoyo", "somtam", "larb", "khaosoi", "roti"];

export interface Config {
  /** Undefined when PAXA_API_KEY is not set; the server still starts so the agent can relay MISSING_KEY_MESSAGE. */
  apiKey: string | undefined;
  baseUrl: string;
  outputDir: string;
  defaultVoice: string;
  /** PAXA_TTS_MODEL: the speech model used when a call does not pick one. */
  ttsModel: TtsModel;
  /** PAXA_DEFAULT_SPEED: speaking rate used when a call does not pick one; undefined means the API's 1. */
  defaultSpeed: number | undefined;
  /** Terms pinned on every transcription, from PAXA_VOCABULARY (comma-separated). */
  vocabulary: string[];
  /** A file with one term per line, also pinned on every transcription. Read at call time, so edits apply without a restart. */
  vocabularyFile: string | undefined;
  /** PAXA_MIC: the microphone device for the listen tool; undefined means the system default. */
  micDevice: string | undefined;
}

/** Split a vocabulary list on the given separator, dropping blanks and, for files, lines that start with "#". */
export function parseVocabulary(body: string, separator: "," | "\n"): string[] {
  return body
    .split(separator)
    .map((term) => term.trim())
    .filter((term) => term.length > 0 && !term.startsWith("#"));
}

export const MISSING_KEY_MESSAGE =
  "PAXA_API_KEY is not set. Ask the user to create an API key at https://paxalabs.com/app/keys " +
  'and pass it to the server, e.g. { "env": { "PAXA_API_KEY": "pxa_..." } } in their MCP client ' +
  "configuration, then restart the server.";

/**
 * A warning when PAXA_DEFAULT_VOICE names a voice the configured model does not carry, typically a setup from
 * before 0.1.0-beta.14 (when v1 was the default and the README suggested donut or toast); undefined otherwise.
 */
export function defaultVoiceWarning(config: Config): string | undefined {
  if (config.ttsModel === "paxa-tts-flash-v1" || !V1_ONLY_VOICES.includes(config.defaultVoice)) return undefined;
  return (
    `PAXA_DEFAULT_VOICE "${config.defaultVoice}" exists only on paxa-tts-flash-v1, but speech runs on ` +
    `${config.ttsModel} since 0.1.0-beta.14, so every speech call that does not pick a voice fails with ` +
    "unknown_voice. Set PAXA_DEFAULT_VOICE to a v2 voice from list_voices, or set PAXA_TTS_MODEL to " +
    "paxa-tts-flash-v1 to stay on v1."
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.PAXA_API_KEY?.trim() || undefined;
  const baseUrl = (env.PAXA_BASE_URL?.trim() || "https://api.paxalabs.com").replace(/\/+$/, "");
  const outputDir = env.PAXA_OUTPUT_DIR?.trim() || process.cwd();
  const defaultVoice = env.PAXA_DEFAULT_VOICE?.trim() || "foithong";
  const modelRaw = env.PAXA_TTS_MODEL?.trim();
  let ttsModel: TtsModel = DEFAULT_TTS_MODEL;
  if (modelRaw) {
    if ((TTS_MODELS as readonly string[]).includes(modelRaw)) ttsModel = modelRaw as TtsModel;
    else process.stderr.write(`Warning: PAXA_TTS_MODEL "${modelRaw}" is not one of ${TTS_MODELS.join(", ")}; using ${DEFAULT_TTS_MODEL}.\n`);
  }
  const speedRaw = Number(env.PAXA_DEFAULT_SPEED?.trim() || "");
  const defaultSpeed = Number.isFinite(speedRaw) && speedRaw > 0 ? Math.min(1.5, Math.max(0.5, speedRaw)) : undefined;
  const vocabulary = parseVocabulary(env.PAXA_VOCABULARY ?? "", ",");
  const vocabularyFile = env.PAXA_VOCABULARY_FILE?.trim() || undefined;
  const micDevice = env.PAXA_MIC?.trim() || undefined;
  return { apiKey, baseUrl, outputDir, defaultVoice, ttsModel, defaultSpeed, vocabulary, vocabularyFile, micDevice };
}
