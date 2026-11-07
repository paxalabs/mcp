# Security

## Reporting a vulnerability

Email hello@paxalabs.com, the contact published at
https://paxalabs.com/.well-known/security.txt. Please do not open a public
GitHub issue for anything that could be exploited before a fix ships.

Include what you found, how to reproduce it, the version of `@paxalabs/mcp`
or of the `.mcpb` bundle, and your platform. We will reply and keep you
informed until the problem is resolved.

## Scope

This repository: the MCP server, the `paxa say` command, and the Claude
Desktop extension bundle built from it. Problems in the Paxa API or the
paxalabs.com website go to the same address.

## What this package does with your data

- The only data sent to `api.paxalabs.com` (over HTTPS) is what the agent
  passes to a tool: the text to speak, translate, or save, the file given
  to `ocr_document`, `extract_fields`, or `transcribe_audio`, and the
  microphone audio while `listen` runs. Nothing else from the conversation
  is read or sent.
- The API key is read from the `PAXA_API_KEY` environment variable, or from
  the paxa entry in `~/.claude.json` when `paxa say` runs as a Claude Code
  hook. This package never writes the key anywhere.
- Without a key, `sign_in` (or `paxa login`) signs in to your Paxa account
  on paxalabs.com, in your browser. The tokens it receives are kept in one
  file: `~/Library/Application Support/paxa/auth.json` on macOS,
  `$XDG_CONFIG_HOME/paxa/auth.json` (or `~/.config/paxa/auth.json`) on
  Linux, `%APPDATA%\paxa\auth.json` on Windows, readable only by you on
  macOS and Linux (mode 0600 in a 0700 folder). `paxa logout` revokes the
  sign-in and removes the file; disconnecting the app under API keys at
  https://paxalabs.com/app/keys ends it from the website.
- The sign-in page opens with the system's opener: `open` on macOS,
  `xdg-open` on Linux, `cmd /c start` on Windows, which refuses any address
  containing shell metacharacters.
- Synthesized audio is written to a temporary directory for playback and
  removed when the server exits. `text_to_speech` writes only to the path
  or output directory you configure.
- `paxa say` keeps the audio of its built-in hook phrases, and of phrases
  you mark with `--cache`, in your user cache directory. Nothing else is
  written there.
- Playback runs a local audio player (afplay, ffplay, mpv, mpg123, paplay,
  aplay, or PowerShell) as a child process with an argument list, never
  through a shell.

How Paxa Labs handles the data it receives is described at
https://paxalabs.com/privacy.
