#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { PaxaClient } from "./api.js";
import { MISSING_KEY_MESSAGE, loadConfig } from "./config.js";
import { SpeechEngine } from "./queue.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.apiKey) console.error(`Warning: ${MISSING_KEY_MESSAGE}`);

  const client = new PaxaClient(config.baseUrl, config.apiKey);
  const engine = new SpeechEngine((text, voice, format) => client.tts({ text, voice, format }));
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
