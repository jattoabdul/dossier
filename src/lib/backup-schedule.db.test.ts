import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings, saveSettings } from "@/lib/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { lastNightlyBackup, nextRun, pruneBackups, runNightlyBackup } from "./backup-schedule";

import { writeBackup } from "./backups";
import { importExport, parseExport } from "./data-import";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
const dataDir = vi.hoisted(() => ({ path: "" }));
vi.mock("@/lib/env", () => ({
  env: { get DOSSIER_DATA_DIR() { return dataDir.path; }, DOSSIER_BACKUP_RETENTION_DAYS: 14, DOSSIER_SECRET: "s".repeat(32) },
}));
vi.mock("@/lib/log", () => ({ logServerError: vi.fn() }));

const prisma = () => db.client!;
const backups = () => readdir(path.join(dataDir.path, "backups")).catch(() => [] as string[]);

beforeEach(async () => {
  dataDir.path = await mkdtemp(path.join(tmpdir(), "dossier-backups-"));
  await resetDatabase(prisma());
  await prisma().application.create({ data: { company: "Ledgerly" } });
});
afterAll(async () => {
  await rm(dataDir.path, { recursive: true, force: true });
  await prisma().$disconnect();
});

describe("nightly backups (E10-7)", () => {
  it("run at the next 03:00", () => {
    expect(nextRun(new Date(2026, 8, 28, 1, 30))).toEqual(new Date(2026, 8, 28, 3, 0));
    expect(nextRun(new Date(2026, 8, 28, 3, 0))).toEqual(new Date(2026, 8, 29, 3, 0));
    expect(nextRun(new Date(2026, 8, 28, 22, 0))).toEqual(new Date(2026, 8, 29, 3, 0));
  });

  it("write an export while they're on", async () => {
    const now = new Date(2026, 8, 28, 3, 0);
    expect(await runNightlyBackup(now)).toBe("written");
    expect(await backups()).toEqual(["dossier-backup-nightly-2026-09-28-030000.json"]);
    expect(await lastNightlyBackup()).toBeInstanceOf(Date);
  });

  it("publishes complete private files without overwriting simultaneous backups", async () => {
    const now = new Date();
    const names = await Promise.all([writeBackup("before-import", now), writeBackup("before-import", now)]);
    expect(new Set(names).size).toBe(2);
    const dir = path.join(dataDir.path, "backups");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    for (const name of names) {
      expect((await stat(path.join(dir, name))).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(path.join(dir, name), "utf8")).applications).toHaveLength(1);
    }
    expect((await readdir(dir)).filter((name) => name.startsWith(".writing-"))).toEqual([]);
  });

  it("write nothing while they're off", async () => {
    await saveSettings({ nightlyBackup: false });
    expect(await runNightlyBackup()).toBe("off");
    expect(await backups()).toEqual([]);
  });

  it("restores application data from the file written by the backup service", async () => {
    const name = await writeBackup("before-import");
    const parsed = parseExport(await readFile(path.join(dataDir.path, "backups", name), "utf8"));
    if (!parsed.ok) throw new Error(parsed.error);
    await prisma().application.updateMany({ data: { company: "Changed after backup" } });
    await importExport(prisma(), parsed.data);
    expect(await prisma().application.findMany({ select: { company: true } })).toEqual([{ company: "Ledgerly" }]);
  });

  it("remove backups past the retention", async () => {
    const dir = path.join(dataDir.path, "backups");
    await runNightlyBackup(new Date(2026, 8, 28, 3));
    const old = path.join(dir, "dossier-backup-nightly-2026-09-01-030000.json");
    await writeFile(old, "{}");
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(old, monthAgo, monthAgo);
    expect(await pruneBackups(new Date())).toBe(1);
    expect(await backups()).toEqual(["dossier-backup-nightly-2026-09-28-030000.json"]);
  });

  it("keep a failure for the settings row, and clear it after a success", async () => {
    // A file where the folder should be: the backup can't be written.
    await writeFile(path.join(dataDir.path, "backups"), "not a folder");
    await expect(runNightlyBackup()).rejects.toThrow();
    expect((await loadSettings()).backupProblem).toMatch(/EEXIST|ENOTDIR/);

    await rm(path.join(dataDir.path, "backups"));
    await runNightlyBackup();
    expect((await loadSettings()).backupProblem).toBeNull();
  });
});
