// Local stdio-to-HTTP MCP bridge. Credentials never appear in command arguments or stdout.
import { readFile, lstat } from "node:fs/promises";
import readline from "node:readline";
const filename = process.argv[2];
if (!filename) throw new Error("Pass the private bridge configuration path.");
const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  let message;
  try {
    if (Buffer.byteLength(line) > 1_000_000) throw new Error("Request too large");
    message = JSON.parse(line);
    const stat = await lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Private configuration permissions required");
    const config = JSON.parse(await readFile(filename, "utf8"));
    const url = new URL(config.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/api/codex/mcp" || url.username || url.password) throw new Error("Invalid local endpoint");
    const response = await fetch(url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(120_000), headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: line });
    if (!response.ok) throw new Error("Connector request failed");
    if (message.id === undefined) { await response.body?.cancel(); continue; }
    const body = await response.text();
    const replies = response.headers.get("content-type")?.includes("text/event-stream") ? body.split(/\r?\n/).filter(x => x.startsWith("data: ")).map(x => JSON.parse(x.slice(6))) : [JSON.parse(body)];
    for (const reply of replies) if (reply.id === message.id) process.stdout.write(JSON.stringify(reply) + "\n");
  } catch {
    if (message?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "Dossier is unavailable or disconnected. Check the local app and Settings > Codex connector." } }) + "\n");
    else process.stderr.write("Dossier bridge could not process a notification.\n");
  }
}
