import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, lstat, readdir } from "node:fs/promises";
import path from "node:path";

export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
export type SourceFile = { id: string; rootKey: string; relativePath: string; collection: string; title: string; kind: string; sha256: string; bytes: number; modifiedAt: string };

/** Only indexed regular files under a configured root. Never follows symlink components. */
export async function readSourceFile(root: string, relativePath: string, expectedHash?: string): Promise<Buffer> {
  if (path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => part === ".." || part === "." || !part)) throw new Error("Invalid source path.");
  const base = await realpath(root);
  let candidate = base;
  for (const part of relativePath.split("/")) {
    candidate = path.join(candidate, part);
    if ((await lstat(candidate)).isSymbolicLink()) throw new Error("Symbolic links are not indexed.");
  }
  const resolved = await realpath(candidate);
  if (!resolved.startsWith(base + path.sep)) throw new Error("Source is outside its library.");
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error("Source is not a supported regular file.");
    const content = await file.readFile();
    if (content.length > MAX_SOURCE_BYTES) throw new Error("Source is too large.");
    if (expectedHash && digest(content) !== expectedHash) throw new Error("This source changed since the index. Re-index it before reading or importing.");
    return content;
  } finally { await file.close(); }
}

export async function indexCareerRoot(root: string, rootKey = "career"): Promise<{ files: SourceFile[]; skipped: string[] }> {
  const files: SourceFile[] = [], skipped: string[] = [];
  const walk = async (relative = "") => {
    for (const entry of (await readdir(path.join(root, relative), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) { skipped.push(name); continue; }
      if (entry.isDirectory()) { await walk(name); continue; }
      if (!entry.isFile()) { skipped.push(name); continue; }
      const stat = await lstat(path.join(root, name));
      if (stat.size > MAX_SOURCE_BYTES) { skipped.push(name); continue; }
      const content = await readSourceFile(root, name);
      files.push({ id: digest(`${rootKey}:${name}`).slice(0,32), rootKey, relativePath: name, collection: name.startsWith("interviews/") && name.split("/").length >= 3 ? name.split("/")[1] : "career-guidance", title: entry.name, kind: path.extname(name).slice(1).toLowerCase() || "binary", sha256: digest(content), bytes: content.length, modifiedAt: stat.mtime.toISOString() });
    }
  };
  await walk();
  return { files, skipped };
}
