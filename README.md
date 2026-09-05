# @paxalabs/mcp

Official [MCP](https://modelcontextprotocol.io) server for the
[Paxa Labs API](https://paxalabs.com/docs): Thai and English speech AI for
your agent, including local audio playback.

An agent connected to this server can speak out loud through your machine's
speakers, read long content aloud as a managed playback queue, save speech to
audio files, translate any language into Thai, and read PDFs and images with
OCR.

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

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `PAXA_API_KEY` | yes | | Your API key. The server starts without it, but every tool that calls the API then fails with setup instructions the agent can relay |
| `PAXA_OUTPUT_DIR` | no | working directory | Where `text_to_speech` saves files |
| `PAXA_DEFAULT_VOICE` | no | `nomyen` | Voice used when a tool call does not pick one |
| `PAXA_BASE_URL` | no | `https://api.paxalabs.com` | API origin override |

## Playback support

| Platform | Player | Pause/resume |
| --- | --- | --- |
| macOS | `afplay` (built in) | yes |
| Linux | `ffplay`, `mpv`, `mpg123`, `paplay`, or `aplay` | yes |
| Windows | `ffplay` if installed, else PowerShell (wav) | no |

If no player is found, speech tools report it clearly and `text_to_speech`
still works.

## Development

```bash
pnpm install
pnpm build        # compile to dist/
pnpm typecheck

# live smoke test (spends a few credits, plays audio out loud)
PAXA_API_KEY=pxa_... TEST_OUT_DIR=/tmp/paxa-out node scripts/e2e.mjs
```
