/** The two speech models the API serves. v2 is the default; v1 stays for its regional accents, its emotion-tag voices, and eight voices v2 does not carry. */
export const TTS_MODELS = ["paxa-tts-flash-v2", "paxa-tts-flash-v1"] as const;
export type TtsModel = (typeof TTS_MODELS)[number];
export const DEFAULT_TTS_MODEL: TtsModel = "paxa-tts-flash-v2";

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.PAXA_API_KEY?.trim() || undefined;
  const baseUrl = (env.PAXA_BASE_URL?.trim() || "https://api.paxalabs.com").replace(/\/+$/, "");
  const outputDir = env.PAXA_OUTPUT_DIR?.trim() || process.cwd();
  const defaultVoice = env.PAXA_DEFAULT_VOICE?.trim() || "nomyen";
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
