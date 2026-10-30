import "server-only";

import { chmod, link, mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { buildExport } from "@/lib/data-export";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

// Backups (E10-6, E10-7): exports written to DOSSIER_DATA_DIR/backups. They
// never hold the API key in plain text.

export type BackupReason = "before-import" | "nightly";

export const backupsDir = () => path.join(env.DOSSIER_DATA_DIR, "backups");

const pad = (value: number) => String(value).padStart(2, "0");

/** "dossier-backup-nightly-2026-09-28-030000.json", in the server's time zone. */
export function backupFileName(reason: BackupReason, now: Date): string {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `dossier-backup-${reason}-${day}-${time}.json`;
}

/** Writes an export of everything to the backups folder; returns the file's name. */
export async function writeBackup(reason: BackupReason, now = new Date()): Promise<string> {
  const data = await buildExport(prisma, { now });
  const dir = backupsDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const temp = path.join(dir, `.writing-${randomUUID()}`);
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(data, null, 2));
    await file.sync();
    await file.close();
    let name = backupFileName(reason, now);
    try {
      // An atomic, no-overwrite publication. Readers never see partial JSON.
      await link(temp, path.join(dir, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      name = name.replace(/\.json$/, `-${randomUUID()}.json`);
      await link(temp, path.join(dir, name));
    }
    return name;
  } finally {
    await file.close();
    await rm(temp, { force: true });
  }
}

/** The backup files, newest first. */
export async function listBackups(): Promise<{ name: string; modified: Date }[]> {
  const names = (await readdir(backupsDir()).catch(() => [])).filter((name) => /^dossier-backup-.*\.json$/.test(name));
  const files = await Promise.all(names.map(async (name) => ({ name, modified: (await stat(path.join(backupsDir(), name))).mtime })));
  return files.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Deletes every backup file (Delete everything, E10-8). */
export async function deleteAllBackups(): Promise<void> {
  await rm(backupsDir(), { recursive: true, force: true });
}
