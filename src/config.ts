export interface Config {
  /** Undefined when PAXA_API_KEY is not set; the server still starts so the agent can relay MISSING_KEY_MESSAGE. */
  apiKey: string | undefined;
  baseUrl: string;
  outputDir: string;
  defaultVoice: string;
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
  return { apiKey, baseUrl, outputDir, defaultVoice };
}
