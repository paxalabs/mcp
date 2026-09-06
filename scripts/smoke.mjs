// Smoke test for CI: start the built server over stdio, list its tools, and
// check the metadata that MCP clients and directories rely on. Needs no API
// key and makes no network calls.
import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
  "speak",
  "queue_speech",
  "control_playback",
  "play_audio",
  "text_to_speech",
  "translate_to_thai",
  "ocr_document",
  "list_voices",
  "list_models",
  "get_account",
];

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const problems = [];

const client = new Client({ name: "smoke", version: "0.0.0" });
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "pipe" });
await client.connect(transport);

const server = client.getServerVersion();
if (server?.version !== pkg.version) {
  problems.push(`server reports version ${server?.version}, package.json says ${pkg.version}`);
}

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
for (const name of EXPECTED_TOOLS) if (!names.includes(name)) problems.push(`missing tool: ${name}`);
for (const name of names) if (!EXPECTED_TOOLS.includes(name)) problems.push(`unexpected tool: ${name}`);

for (const tool of tools) {
  const a = tool.annotations ?? {};
  if (!tool.description) problems.push(`${tool.name}: no description`);
  if (!tool.title) problems.push(`${tool.name}: no title`);
  if (a.title !== tool.title) problems.push(`${tool.name}: annotations.title does not match title`);
  for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
    if (typeof a[key] !== "boolean") problems.push(`${tool.name}: annotations.${key} is not set`);
  }
  if (tool.name.length > 64) problems.push(`${tool.name}: name longer than 64 characters`);
}

await client.close();

if (problems.length > 0) {
  console.error("smoke test failed:\n  " + problems.join("\n  "));
  process.exit(1);
}
console.log(`smoke ok: version ${server.version}, ${tools.length} tools, all described, titled, and annotated`);
