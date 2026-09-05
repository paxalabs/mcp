#!/usr/bin/env node
// Build a Claude Desktop extension (.mcpb) from the current tree.
//
// The bundle contains exactly what npm publishes (via npm pack) plus a flat
// node_modules with the runtime dependencies, a manifest generated from
// package.json and the server's own tool list, and the icon.
// Output: release/paxalabs-mcp-<version>.mcpb
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const MCPB_CLI = "@anthropic-ai/mcpb@2.1.2";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const release = join(root, "release");
const staging = join(release, "mcpb-staging");

rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });

// 1. Pack what npm would publish and unpack it into the staging directory.
const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", release], {
  cwd: root,
  encoding: "utf8",
}).trim();
execFileSync("tar", ["xzf", join(release, tarball), "-C", staging, "--strip-components=1"]);
rmSync(join(release, tarball));

// 2. Runtime dependencies as a plain tree. npm rather than pnpm on purpose:
//    the bundle must not contain symlinks.
execFileSync(
  "npm",
  ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock", "--silent"],
  { cwd: staging, stdio: "inherit" },
);

// 3. Ask the freshly built server for its tools so the manifest never drifts.
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(staging, "dist", "index.js")],
  env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  stderr: "ignore",
});
const client = new Client({ name: "build-mcpb", version: pkg.version });
await client.connect(transport);
const firstSentence = (s) => (s.match(/^.*?[.!?](?=\s|$)/) ?? [s])[0];
const tools = (await client.listTools()).tools.map((t) => ({
  name: t.name,
  description: firstSentence(t.description ?? ""),
}));
await client.close();

// 4. Manifest.
const manifest = {
  manifest_version: "0.3",
  name: "paxalabs-mcp",
  display_name: "Paxa Labs",
  version: pkg.version,
  description:
    "Thai and English speech AI: speak out loud, read long content aloud, save speech to files, translate into Thai, and OCR documents.",
  long_description:
    "Official Paxa Labs extension. Claude can speak through this machine's speakers, read stories and articles " +
    "aloud as a managed queue with pause, resume, skip, and clear, save speech as mp3, opus, or wav files, " +
    "translate any language into Thai, and read PDFs and images with OCR.\n\n" +
    "Requires a Paxa API key from https://paxalabs.com/app/keys (new accounts include free credits). " +
    "Paid tools spend account credits; every tool description states its price. " +
    "Docs: https://paxalabs.com/docs",
  author: { name: "Paxa Labs", url: "https://paxalabs.com" },
  repository: { type: "git", url: "https://github.com/paxalabs/mcp" },
  homepage: "https://paxalabs.com/docs",
  documentation: "https://paxalabs.com/docs",
  support: "https://github.com/paxalabs/mcp/issues",
  icon: "icon.png",
  server: {
    type: "node",
    entry_point: "dist/index.js",
    mcp_config: {
      command: "node",
      args: ["${__dirname}/dist/index.js"],
      env: {
        PAXA_API_KEY: "${user_config.api_key}",
        PAXA_OUTPUT_DIR: "${user_config.output_dir}",
        PAXA_DEFAULT_VOICE: "${user_config.default_voice}",
      },
    },
  },
  tools,
  tools_generated: false,
  keywords: pkg.keywords,
  license: pkg.license,
  privacy_policies: ["https://paxalabs.com/privacy"],
  compatibility: {
    platforms: ["darwin", "win32", "linux"],
    runtimes: { node: ">=20" },
  },
  user_config: {
    api_key: {
      type: "string",
      title: "Paxa API key",
      description: "Create one at https://paxalabs.com/app/keys. New accounts include free credits.",
      sensitive: true,
      required: true,
    },
    output_dir: {
      type: "directory",
      title: "Audio output folder",
      description: "Where text_to_speech saves audio files.",
      required: false,
      default: "${HOME}/Downloads",
    },
    default_voice: {
      type: "string",
      title: "Default voice",
      description: "Voice id used when a request does not pick one. Ask for list_voices to see the roster.",
      required: false,
      default: "nomyen",
    },
  },
};
writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
cpSync(join(root, "assets", "icon.png"), join(staging, "icon.png"));

// 5. Validate and pack.
const out = join(release, `paxalabs-mcp-${pkg.version}.mcpb`);
rmSync(out, { force: true });
execFileSync("npx", ["-y", MCPB_CLI, "validate", staging], { stdio: "inherit" });
execFileSync("npx", ["-y", MCPB_CLI, "pack", staging, out], { stdio: "inherit" });
rmSync(staging, { recursive: true, force: true });
console.log(`\nBuilt ${out}`);
