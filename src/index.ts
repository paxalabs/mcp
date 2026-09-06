#!/usr/bin/env node
import { MISSING_KEY_MESSAGE, loadConfig } from "./config.js";

async function main(): Promise<void> {
  // `paxa say ...` speaks a line and exits; with no subcommand we are the MCP
  // server. Each side is imported only when chosen: `paxa say` runs on every
  // hook notification, and loading the MCP SDK there would cost it about
  // 60 ms for nothing.
  if (process.argv[2] === "say") {
    const { runSay } = await import("./say.js");
    await runSay(process.argv.slice(3));
    return;
  }

  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { PaxaClient } = await import("./api.js");
  const { SpeechEngine } = await import("./queue.js");
  const { createServer } = await import("./server.js");

  const config = loadConfig();
  if (!config.apiKey) console.error(`Warning: ${MISSING_KEY_MESSAGE}`);

  const client = new PaxaClient(config.baseUrl, config.apiKey);
  const engine = new SpeechEngine({
    buffered: (text, voice, format) => client.tts({ text, voice, format }),
    stream: (text, voice, signal) => client.ttsStream({ text, voice, format: "mp3" }, signal),
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
