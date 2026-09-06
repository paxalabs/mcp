#!/usr/bin/env node
// paxa-say: speak one line from the command line, or from a Claude Code hook.
//
//   paxa-say "Build finished"                 speak the arguments
//   paxa-say --voice cookie "Hello"           pick a voice
//   echo "text" | paxa-say                    speak stdin
//   Claude Code hook (stdin is the hook JSON) speak a phrase chosen by event type
//
// The key comes from PAXA_API_KEY, or, when that is unset, from the paxa
// server entry in ~/.claude.json so Claude Code users need no extra setup.
// In hook mode the exit code is always 0: a failed notification must never
// block Claude Code.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PaxaClient } from "./api.js";
import { MISSING_KEY_MESSAGE, loadConfig } from "./config.js";
import { SpeechEngine } from "./queue.js";

const PHRASES: Record<string, string> = {
  permission_prompt: "Claude needs your permission.",
  idle_prompt: "Claude is waiting for you.",
  agent_needs_input: "Claude has a question for you.",
  elicitation_dialog: "Claude needs some input from you.",
  agent_completed: "Claude finished.",
  Stop: "Done.",
  StopFailure: "Claude stopped with an error.",
};

function usage(): never {
  process.stderr.write(
    "Usage: paxa-say [--voice <id>] <text>\n" +
      "       echo <text> | paxa-say\n" +
      "       (as a Claude Code hook, with the hook JSON on stdin)\n",
  );
  process.exit(64);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Turn a Claude Code hook payload into a spoken phrase, or undefined when stdin is not a hook payload. */
function phraseFromHook(raw: string): string | undefined {
  if (!raw.startsWith("{")) return undefined;
  try {
    const hook = JSON.parse(raw) as { hook_event_name?: string; notification_type?: string; message?: string };
    const type = hook.notification_type ?? hook.hook_event_name;
    if (!type) return undefined;
    return PHRASES[type] ?? hook.message ?? `Claude Code: ${type.replace(/_/g, " ")}.`;
  } catch {
    return undefined;
  }
}

/** The key of the paxa MCP server configured in Claude Code, if any. */
function keyFromClaudeConfig(): string | undefined {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".claude.json"), "utf8")) as {
      mcpServers?: Record<string, { env?: Record<string, string> }>;
      projects?: Record<string, { mcpServers?: Record<string, { env?: Record<string, string> }> }>;
    };
    const scopes = [cfg.mcpServers ?? {}, ...Object.values(cfg.projects ?? {}).map((p) => p.mcpServers ?? {})];
    for (const servers of scopes) {
      for (const server of Object.values(servers)) {
        const key = server.env?.PAXA_API_KEY?.trim();
        if (key) return key;
      }
    }
  } catch {
    // No Claude Code config, or not readable: fall through.
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let voice: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--voice" || arg === "-v") voice = args[++i];
    else words.push(arg);
  }

  let hookMode = false;
  let text = words.join(" ").trim();
  if (!text) {
    const stdin = await readStdin();
    const phrase = phraseFromHook(stdin);
    hookMode = phrase !== undefined;
    text = phrase ?? stdin;
  }
  if (!text) usage();

  const fail = (message: string): never => {
    process.stderr.write(`paxa-say: ${message}\n`);
    process.exit(hookMode ? 0 : 1);
  };

  const config = loadConfig({
    ...process.env,
    PAXA_API_KEY: process.env.PAXA_API_KEY?.trim() || keyFromClaudeConfig() || "",
  });
  if (!config.apiKey) fail(MISSING_KEY_MESSAGE);

  const client = new PaxaClient(config.baseUrl, config.apiKey);
  const engine = new SpeechEngine({
    buffered: (t, v, format) => client.tts({ text: t, voice: v, format }),
    stream: (t, v, signal) => client.ttsStream({ text: t, voice: v, format: "mp3" }, signal),
  });
  const [segment] = engine.enqueueTts([text.slice(0, 2000)], voice ?? config.defaultVoice, true);
  const settled = await engine.waitFor(segment as NonNullable<typeof segment>);
  engine.dispose();
  if (settled.status !== "done") fail(settled.error ?? `playback ${settled.status}`);
}

main().catch((err: unknown) => {
  process.stderr.write(`paxa-say: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
