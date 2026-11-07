#!/usr/bin/env node
import { MISSING_KEY_MESSAGE, defaultVoiceWarning, loadConfig } from "./config.js";

async function main(): Promise<void> {
  // `paxa say ...` speaks a line and exits, `paxa login` and `paxa logout`
  // manage the sign-in; with no subcommand we are the MCP server. Each side is
  // imported only when chosen: `paxa say` runs on every hook notification, and
  // loading the MCP SDK there would cost it about 60 ms for nothing.
  if (process.argv[2] === "say") {
    const { runSay } = await import("./say.js");
    await runSay(process.argv.slice(3));
    return;
  }
  if (process.argv[2] === "login" || process.argv[2] === "logout") {
    const { runLogin, runLogout } = await import("./login.js");
    await (process.argv[2] === "login" ? runLogin() : runLogout());
    return;
  }

  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { PaxaClient } = await import("./api.js");
  const { Credentials, readStoredAuth } = await import("./auth.js");
  const { SpeechEngine } = await import("./queue.js");
  const { createServer } = await import("./server.js");

  const config = loadConfig();
  if (!config.apiKey && !readStoredAuth()) console.error(`Warning: ${MISSING_KEY_MESSAGE}`);
  const voiceWarning = defaultVoiceWarning(config);
  if (voiceWarning) console.error(`Warning: ${voiceWarning}`);

  const client = new PaxaClient(config.baseUrl, new Credentials(config.apiKey));
  const engine = new SpeechEngine({
    buffered: (text, voice, format, options) => client.tts({ text, voice, format, ...options }),
    stream: (text, voice, signal, options) => client.ttsStream({ text, voice, format: "mp3", ...options }, signal),
  });
  const server = createServer(config, client, engine);

  const shutdown = (): void => {
    engine.dispose();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
