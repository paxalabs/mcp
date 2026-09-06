#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { PaxaClient } from "./api.js";
import { MISSING_KEY_MESSAGE, loadConfig } from "./config.js";
import { runSay } from "./say.js";
import { SpeechEngine } from "./queue.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  // `paxa say ...` speaks a line and exits; with no subcommand we are the MCP server.
  if (process.argv[2] === "say") {
    await runSay(process.argv.slice(3));
    return;
  }

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
