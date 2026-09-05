export interface Config {
  apiKey: string;
  baseUrl: string;
  outputDir: string;
  defaultVoice: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.PAXA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "PAXA_API_KEY is not set. Create an API key at https://paxalabs.com and " +
        'pass it to the server, e.g. { "env": { "PAXA_API_KEY": "pxa_..." } } ' +
        "in your MCP client configuration.",
    );
  }
  const baseUrl = (env.PAXA_BASE_URL?.trim() || "https://api.paxalabs.com").replace(/\/+$/, "");
  const outputDir = env.PAXA_OUTPUT_DIR?.trim() || process.cwd();
  const defaultVoice = env.PAXA_DEFAULT_VOICE?.trim() || "nomyen";
  return { apiKey, baseUrl, outputDir, defaultVoice };
}
