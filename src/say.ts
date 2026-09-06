// `paxa say`: speak one line from the command line, or from a Claude Code hook.
//
//   paxa say "Build finished"                 speak the arguments
//   paxa say --voice cookie "Hello"           pick a voice
//   paxa say --cache "Need your OK"           speak and keep the audio for next time
//   echo "text" | paxa say                    speak stdin
//   Claude Code hook (stdin is the hook JSON) speak a phrase chosen by event type
//
// The key comes from PAXA_API_KEY, or, when that is unset, from the paxa
// server entry in ~/.claude.json so Claude Code users need no extra setup.
// In hook mode the exit code is always 0: a failed notification must never
// block Claude Code.
//
// The built-in hook phrases are synthesized once per voice and kept in the
// user's cache directory, so later notifications play from disk: no network
// round trip and no credits. Text the user supplies gets the same treatment
// only when they ask with --cache (meant for custom phrases in hook
// commands). Messages carried inside a hook payload are never written there.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";

import { PaxaClient } from "./api.js";
import { MISSING_KEY_MESSAGE, loadConfig } from "./config.js";
import { playbackFormat, playClip } from "./player.js";
import { SpeechEngine } from "./queue.js";

const PHRASES: Record<string, string> = {
  permission_prompt: "Permission needed.",
  idle_prompt: "Waiting for you.",
  agent_needs_input: "Question for you.",
  elicitation_dialog: "Input needed.",
  agent_completed: "Finished.",
  Stop: "Done.",
  StopFailure: "Stopped with an error.",
};

interface Phrase {
  text: string;
  /** The hook event type when the text is one of the built-in PHRASES. Only those phrases are cached. */
  builtin?: string;
}

function usage(): never {
  process.stderr.write(
    "Usage: paxa say [--voice <id>] [--cache] <text>\n" +
      "       echo <text> | paxa say [--voice <id>] [--cache]\n" +
      "       (as a Claude Code hook, with the hook JSON on stdin)\n" +
      "\n" +
      "  --voice <id>  voice from list_voices (default: PAXA_DEFAULT_VOICE or nomyen)\n" +
      "  --cache       keep the audio and replay it next time, for fixed phrases in hook commands\n",
  );
  process.exit(64);
}

function warn(message: string): void {
  process.stderr.write(`paxa say: ${message}\n`);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Turn a Claude Code hook payload into a spoken phrase, or undefined when stdin is not a hook payload. */
function phraseFromHook(raw: string): Phrase | undefined {
  if (!raw.startsWith("{")) return undefined;
  try {
    const hook = JSON.parse(raw) as { hook_event_name?: string; notification_type?: string; message?: string };
    const type = hook.notification_type ?? hook.hook_event_name;
    if (!type) return undefined;
    const builtin = PHRASES[type];
    if (builtin) return { text: builtin, builtin: type };
    return { text: hook.message ?? `Claude Code: ${type.replace(/_/g, " ")}.` };
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

/** Per-user cache directory for the built-in phrases, following each platform's convention. */
function phraseCacheDir(): string {
  const home = homedir();
  switch (process.platform) {
    case "darwin":
      return join(home, "Library", "Caches", "paxa", "say");
    case "win32":
      return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "paxa", "cache", "say");
    default:
      return join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "paxa", "say");
  }
}

/**
 * Where the audio of a phrase lives. `kind` is the hook event for a built-in
 * phrase, or "custom" for text kept with --cache. The name also carries the
 * voice and a hash of the exact text, so a reworded phrase or another voice
 * never replays a stale file.
 */
function phraseCachePath(kind: string, text: string, voice: string): string {
  const hash = createHash("sha256").update(`${voice}\n${text}`).digest("hex").slice(0, 12);
  const safeVoice = voice.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(phraseCacheDir(), `${kind}-${safeVoice}-${hash}.${playbackFormat()}`);
}

/**
 * Play a cached phrase. Returns false when it could not be played; a file
 * that fails is discarded so the caller synthesizes it again.
 */
async function replayPhrase(file: string): Promise<boolean> {
  const handle = playClip(file);
  if (!handle) return false;
  try {
    await handle.done;
    return true;
  } catch (err) {
    warn(`discarding cached phrase that failed to play: ${err instanceof Error ? err.message : String(err)}`);
    rmSync(file, { force: true });
    return false;
  }
}

/** Keep the audio of a built-in phrase for next time. A failure only costs the cache, so it is reported and ignored. */
function storePhrase(file: string | undefined, cache: string): void {
  if (!file || extname(file) !== extname(cache)) return;
  try {
    mkdirSync(dirname(cache), { recursive: true });
    // Write to a temporary name and rename, so a concurrent `paxa say` never plays a half-written file.
    const tmp = `${cache}.${process.pid}.tmp`;
    copyFileSync(file, tmp);
    renameSync(tmp, cache);
  } catch (err) {
    warn(`could not cache the phrase: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Runs the `say` subcommand. `args` are the arguments after "say". */
export async function runSay(args: string[]): Promise<void> {
  let voice: string | undefined;
  let cacheWanted = false;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--help" || arg === "-h") usage();
    else if (arg === "--voice" || arg === "-v") voice = args[++i];
    else if (arg === "--cache") cacheWanted = true;
    else words.push(arg);
  }

  let hookMode = false;
  let builtin: string | undefined;
  let text = words.join(" ").trim();
  if (!text) {
    const stdin = await readStdin();
    const phrase = phraseFromHook(stdin);
    hookMode = phrase !== undefined;
    text = phrase?.text ?? stdin;
    builtin = phrase?.builtin;
  }
  if (!text) usage();
  text = text.slice(0, 2000);

  const fail = (message: string): never => {
    warn(message);
    process.exit(hookMode ? 0 : 1);
  };

  const config = loadConfig();
  const chosenVoice = voice ?? config.defaultVoice;
  // Cached: a built-in phrase, or text the user supplied together with --cache.
  // A message taken from a hook payload is never cached, even with --cache.
  const cacheAs = builtin ?? (cacheWanted && !hookMode ? "custom" : undefined);
  const cache = cacheAs ? phraseCachePath(cacheAs, text, chosenVoice) : undefined;
  if (cache && existsSync(cache) && (await replayPhrase(cache))) return;

  const apiKey = config.apiKey ?? keyFromClaudeConfig();
  if (!apiKey) fail(MISSING_KEY_MESSAGE);

  const client = new PaxaClient(config.baseUrl, apiKey as string);
  const engine = new SpeechEngine({
    buffered: (t, v, format) => client.tts({ text: t, voice: v, format }),
    stream: (t, v, signal) => client.ttsStream({ text: t, voice: v, format: "mp3" }, signal),
  });
  const [segment] = engine.enqueueTts([text], chosenVoice, true);
  const settled = await engine.waitFor(segment as NonNullable<typeof segment>);
  if (settled.status === "done" && cache) storePhrase(settled.file, cache);
  engine.dispose();
  if (settled.status !== "done") fail(settled.error ?? `playback ${settled.status}`);
}
