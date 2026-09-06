# @paxalabs/mcp

[![npm](https://img.shields.io/npm/v/@paxalabs/mcp)](https://www.npmjs.com/package/@paxalabs/mcp)
[![CI](https://github.com/paxalabs/mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/paxalabs/mcp/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@paxalabs/mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@paxalabs/mcp)](LICENSE)
[![Claude Desktop bundle](https://img.shields.io/github/v/release/paxalabs/mcp?include_prereleases&label=Claude%20Desktop%20.mcpb)](https://github.com/paxalabs/mcp/releases)

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=paxa&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBwYXhhbGFicy9tY3AiXSwiZW52Ijp7IlBBWEFfQVBJX0tFWSI6InB4YV95b3VyX2tleV9oZXJlIn19)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=paxa&config=%7B%22name%22%3A%22paxa%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40paxalabs/mcp%22%5D%2C%22env%22%3A%7B%22PAXA_API_KEY%22%3A%22pxa_your_key_here%22%7D%7D)

Official [MCP](https://modelcontextprotocol.io) server for the
[Paxa Labs API](https://paxalabs.com/docs): Thai and English speech AI for
your agent, including local audio playback.

An agent connected to this server can speak out loud through your machine's
speakers, read long content aloud as a managed playback queue, save speech to
audio files, translate any language into Thai, and read PDFs and images with
OCR.

> **Beta.** The tool set is complete and tested end to end, but tool names and
> behavior may still change before 1.0 as feedback comes in. Report problems at
> https://github.com/paxalabs/mcp/issues.

## Quick start

You need a Paxa API key from [paxalabs.com](https://paxalabs.com). New
accounts include free credits.

### Claude Code

```bash
claude mcp add paxa -e PAXA_API_KEY=pxa_your_key_here -- npx -y @paxalabs/mcp
```

### Claude Desktop, Cursor, and other MCP clients

Add to your client's MCP configuration (for Claude Desktop:
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "paxa": {
      "command": "npx",
      "args": ["-y", "@paxalabs/mcp"],
      "env": {
        "PAXA_API_KEY": "pxa_your_key_here"
      }
    }
  }
}
```

**One click for Cursor or VS Code:** the buttons install the same entry
into `~/.cursor/mcp.json` or VS Code's MCP settings. Then replace
`pxa_your_key_here` in the `paxa` entry with your key.

[![Add to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=paxa&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBwYXhhbGFicy9tY3AiXSwiZW52Ijp7IlBBWEFfQVBJX0tFWSI6InB4YV95b3VyX2tleV9oZXJlIn19)
[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=paxa&config=%7B%22name%22%3A%22paxa%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40paxalabs/mcp%22%5D%2C%22env%22%3A%7B%22PAXA_API_KEY%22%3A%22pxa_your_key_here%22%7D%7D)

## Tools

| Tool | What it does | Credits |
| --- | --- | --- |
| `speak` | Synthesize a short line and play it through the speakers, blocking until done | 15 per 1000 chars |
| `queue_speech` | Read long content aloud: auto-chunks, synthesizes ahead while playing, returns immediately | 15 per 1000 chars |
| `control_playback` | Control the shared audio queue: `status`, `pause`, `resume`, `skip`, `clear` | free |
| `play_audio` | Play a local audio file through the speakers | free |
| `text_to_speech` | Synthesize speech to an audio file (mp3, opus, wav) without playing it | 15 per 1000 chars |
| `translate_to_thai` | Translate any language into Thai, with formality, glossary, and context controls | 25 per 1000 chars |
| `ocr_document` | OCR a local PDF, PNG, JPEG, or WebP into Markdown or structured blocks | 6.5 per page |
| `list_voices` | The TTS voice roster with character notes | free |
| `list_models` | Available models, limits, and pricing | free |
| `get_account` | Credit balance, plan, and rate limits | free |

All audio flows through one ordered queue, so sounds never overlap: `speak`
lines slip in ahead of queued long-form segments, and `queue_speech` keeps a
book or article flowing gap-free by synthesizing the next segment while the
current one plays.

With a streaming-capable player installed (see below), speech starts on the
first bytes from the API instead of after the full download: about 0.3 s to
the first word regardless of length, versus 0.7 s for a short line and 2.5 s
for a long paragraph when buffered.

## Voice mode for Claude Code

Three pieces turn Claude Code into something you can walk away from: it
talks when it has news, and it calls you when it needs you.

**1. Install the server** (Quick start above).

**2. Tell Claude when to talk.** Add this to `~/.claude/CLAUDE.md`, or to
one project's CLAUDE.md:

```markdown
## Voice

I have the Paxa MCP server (tools: speak, queue_speech, control_playback).
I am often away from the screen, so use voice like this:

- At the end of a turn where you did real work, call speak with a one or
  two sentence summary before writing the final message: what you did,
  what is next, and anything you need from me.
- When you need a decision from me, speak the question too.
- Keep it short and conversational. Never read code, file paths, logs, or
  long lists aloud. Those stay in text.
- Do not speak for quick back-and-forth or trivial answers.
- If I ask to hear something long, use queue_speech.
- Speak in the language I write in.
```

**3. Get told when Claude needs you.** When Claude Code waits for a
permission or an answer, the model is not running, so it cannot call
speak. Claude Code fires a hook at those moments instead, and `paxa say`
turns the hook into a spoken phrase such as "Permission needed." Put
the `paxa` command on your PATH:

```bash
npm install -g @paxalabs/mcp
```

Then add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt|idle_prompt|agent_needs_input",
        "hooks": [{ "type": "command", "command": "paxa say" }]
      }
    ]
  }
}
```

`paxa say` takes the key from `PAXA_API_KEY`, or from the paxa entry in
`~/.claude.json` when that is unset, so step 1 is all the setup it needs.
A `Stop` hook configured the same way speaks "Done." at the end of every
turn.

The built-in phrases are synthesized once per voice and kept in your
user cache directory (`~/Library/Caches/paxa/say` on macOS,
`~/.cache/paxa/say` on Linux, `%LOCALAPPDATA%\paxa\cache\say` on
Windows). After that first play, which costs well under one credit, a
notification plays from disk: no network round trip and no credits.

To change the words, write your own text in the hook command and add
`--cache` so it gets the same treatment. One entry per event, since the
matcher picks the event:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{ "type": "command", "command": "paxa say --cache \"Hey, need your OK\"" }]
      },
      {
        "matcher": "idle_prompt|agent_needs_input",
        "hooks": [{ "type": "command", "command": "paxa say --cache --voice cookie \"Your turn\"" }]
      }
    ]
  }
}
```

Without `--cache`, nothing you type or pipe into `paxa say` is written to
disk, and messages carried inside a hook payload never are.

On macOS the built-in `afplay` needs about half a second just to start
and stop, which is most of the delay you hear on a short phrase. With
`brew install mpg123` (or `ffmpeg`) installed, cached phrases play
through that instead: mpg123 starts in about 50 ms, ffplay in about 300 ms.

`paxa say` also works on its own:

```bash
paxa say "Build finished"
paxa say --voice cookie "Deploy is live"
```

If your editor or desktop app was not launched from a terminal, its PATH
may not include your node bin directory, and the hook will fail silently.
Use the absolute path to `paxa` in the hook command if that happens.

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PAXA_API_KEY` | yes | | Your API key. The server starts without it, but every tool that calls the API then fails with setup instructions the agent can relay |
| `PAXA_OUTPUT_DIR` | no | working directory | Where `text_to_speech` saves files |
| `PAXA_DEFAULT_VOICE` | no | `nomyen` | Voice used when a tool call does not pick one. English text usually sounds best with an English voice (`donut`, `cookie`, `toast`, `latte`) |
| `PAXA_BASE_URL` | no | `https://api.paxalabs.com` | API origin override |

## Playback support

| Platform | File player | Streaming player | Pause/resume |
| --- | --- | --- | --- |
| macOS | `afplay` (built in) | `ffplay`, `mpv`, or `mpg123` if installed | yes |
| Linux | `ffplay`, `mpv`, `mpg123`, `paplay`, or `aplay` | `ffplay`, `mpv`, or `mpg123` | yes |
| Windows | `ffplay` if installed, else PowerShell (wav) | `ffplay` if installed | no |

Streaming needs a player that reads from stdin. On macOS, `brew install
ffmpeg` (or `mpv`) enables it; without one, speech still plays through
`afplay` after the download completes. If no player is found at all, speech
tools report it clearly and `text_to_speech` still works.

## Claude Desktop extension

Each release on GitHub ships a `.mcpb` bundle. Download it, open it with
Claude Desktop, and enter your API key in the extension settings. The bundle
carries its own copy of the server and its dependencies, so it works without
Node.js or npm on the machine.

## Development

```bash
pnpm install
pnpm build        # compile to dist/
pnpm typecheck
pnpm mcpb         # build release/paxalabs-mcp-<version>.mcpb for Claude Desktop

# live smoke test (spends a few credits, plays audio out loud)
PAXA_API_KEY=pxa_... TEST_OUT_DIR=/tmp/paxa-out node scripts/e2e.mjs
```
