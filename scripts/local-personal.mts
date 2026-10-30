// Local personal instance lifecycle. Original career folders are read-only sources.
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/lib/auth/password-hash";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, ".local-personal");
const container = "dossier-local-personal";
const volume = "dossier-local-personal-pgdata";
const label = "dev.dossier.purpose=personal-career";
const envFile = path.join(dir, "env.json");
process.chdir(root);
if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Use Node 24 (see .tool-versions).");
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
const writePrivate = (name: string, value: string) => {
  const dest = path.join(dir, name);
  writeFileSync(dest, value, { mode: 0o600 });
  chmodSync(dest, 0o600);
};
const run = (command: string, args: string[], env = process.env): string => execFileSync(command, args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
function configuration(): Record<string, string> {
  if (!existsSync(envFile)) throw new Error("Run `corepack yarn personal init` first.");
  return JSON.parse(readFileSync(envFile, "utf8"));
}
function childEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_ENV: "production", ...configuration() };
}
function ownContainer(): boolean {
  let owner: string;
  try { owner = run("docker", ["inspect", "--format", '{{ index .Config.Labels "dev.dossier.purpose" }}', container]).trim(); }
  catch { return false; }
  if (owner !== "personal-career") throw new Error("A container with this name already exists and is not this personal.");
  return true;
}
async function databaseReady() {
  for (let i = 0; i < 50; i++) {
    try { run("docker", ["exec", container, "pg_isready", "-U", "dossier_personal", "-d", "dossier_personal"]); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  throw new Error("Personal database did not become ready.");
}
function processAlive(name: string): number | null {
  const filename = path.join(dir, `${name}.pid`);
  if (!existsSync(filename)) return null;
  const pid = Number(readFileSync(filename, "utf8"));
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("Invalid personal PID file.");
  try {
    const command = run("ps", ["-p", String(pid), "-o", "command="]);
    const marker = name === "app" ? "next-server" : "e2e/fake-ai.mts";
    if (!command.includes(marker)) throw new Error("Personal PID belongs to another process; inspect before stopping.");
    const cwd = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    if (!cwd.split("\n").some((line) => line === `n${root}` || line === `n${root}/.next/standalone`)) {
      throw new Error("Personal PID belongs to another directory; inspect before stopping.");
    }
    return pid;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Personal PID")) throw error;
    return null;
  }
}
function launch(name: string, args: string[]) {
  if (processAlive(name)) return;
  const log = openSync(path.join(dir, `${name}.log`), "a", 0o600);
  const child = spawn(process.execPath, args, { cwd: root, env: childEnv(), detached: true, stdio: ["ignore", log, log] });
  child.unref();
  closeSync(log);
  writePrivate(`${name}.pid`, String(child.pid));
}

const command = process.argv[2];
if (command === "init") {
  if (!existsSync(envFile)) {
    if (ownContainer()) throw new Error("Personal container exists but its local configuration is missing. Restore it before continuing.");
    const password = randomBytes(18).toString("base64url");
    const dbPassword = randomBytes(24).toString("hex");
    writePrivate("postgres.env", `POSTGRES_USER=dossier_personal\nPOSTGRES_DB=dossier_personal\nPOSTGRES_PASSWORD=${dbPassword}\n`);
    writePrivate("env.json", JSON.stringify({
      DATABASE_URL: `postgresql://dossier_personal:${dbPassword}@127.0.0.1:35434/dossier_personal`,
      DOSSIER_PASSWORD: await hashPassword(password), DOSSIER_SECRET: randomBytes(32).toString("hex"),
      DOSSIER_DATA_DIR: path.join(dir, "data"), DOSSIER_DEMO_MODE: "off", DOSSIER_EMAIL_SEND: "off", DOSSIER_TELEMETRY: "off",
      DOSSIER_JOBS_SOURCE: "off", DOSSIER_JOBS_ARBEITSAGENTUR: "off",
      DOSSIER_AI_PROVIDER: "openai",
      DOSSIER_PUBLIC_URL: "http://127.0.0.1:3401",
      DOSSIER_CAREER_ROOT: process.env.DOSSIER_CAREER_ROOT ?? "",
      DOSSIER_IMPORTS_ROOT: path.join(dir, "imports"),
      DOSSIER_CODEX_BRIDGE_FILE: path.join(dir, "codex-bridge.json"),
      DOSSIER_CODEX_SETUP_COMMAND: `codex mcp add dossier -- ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(root, "scripts/codex-bridge.mjs"))} ${JSON.stringify(path.join(dir, "codex-bridge.json"))}`,
      HOSTNAME: "127.0.0.1", PORT: "3401", NEXT_TELEMETRY_DISABLED: "1",
    }, null, 2));
    writePrivate("LOGIN.md", `# Personal career login\n\nAddress: http://127.0.0.1:3401\n\nPassword: \`${password}\`\n\nThis login is local to the personal instance. No real OpenAI key is configured.\n`);
  }
  if (!ownContainer()) {
    run("docker", ["run", "-d", "--name", container, "--label", label, "--env-file", path.join(dir, "postgres.env"),
      "--publish", "127.0.0.1:35434:5432", "--volume", `${volume}:/var/lib/postgresql`, "--memory", "512m", "--cpus", "1", "postgres:18-alpine"]);
  } else run("docker", ["start", container]);
  await databaseReady();
  const log = openSync(path.join(dir, "setup.log"), "a", 0o600);
  try {
    for (const args of [["node_modules/prisma/build/index.js", "migrate", "deploy"], ["node_modules/tsx/dist/cli.mjs", "prisma/seed.ts"]]) {
      execFileSync(process.execPath, args, { cwd: root, env: childEnv(), stdio: ["ignore", log, log] });
    }
  } finally { closeSync(log); }
  console.log("Personal database initialized. Login is in .local-personal/LOGIN.md. Build the app, then run `corepack yarn personal start`.");
} else if (command === "start") {
  configuration();
  if (!existsSync(path.join(root, ".next/standalone/server.js"))) throw new Error("Run `corepack yarn build` first.");
  if (!ownContainer()) throw new Error("Personal database is missing. Run init first.");
  run("docker", ["start", container]);
  await databaseReady();
  cpSync("public", ".next/standalone/public", { recursive: true });
  cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
  launch("app", [".next/standalone/server.js"]);
  console.log("Personal starting at http://127.0.0.1:3401. Login: .local-personal/LOGIN.md. Logs: .local-personal/*.log.");
} else if (command === "stop") {
  for (const name of ["app"]) {
    const pid = processAlive(name);
    if (pid) process.kill(pid, "SIGTERM");
  }
  if (ownContainer()) run("docker", ["stop", container]);
  console.log("Personal stopped. Database volume, backups and configuration retained.");
} else if (command === "backup") {
  configuration();
  if (!ownContainer()) throw new Error("Personal database is missing.");
  const backups = path.join(dir, "backups");
  mkdirSync(backups, { recursive: true, mode: 0o700 });
  const filename = path.join(backups, `personal-${new Date().toISOString().replace(/[:.]/g, "-")}.dump`);
  const out = openSync(filename, "wx", 0o600);
  try { execFileSync("docker", ["exec", container, "pg_dump", "-U", "dossier_personal", "-d", "dossier_personal", "-Fc"], { stdio: ["ignore", out, "pipe"] }); }
  finally { closeSync(out); }
  console.log(`Personal database backup saved: ${path.relative(root, filename)}`);
} else if (command === "status") {
  console.log(JSON.stringify({ app: Boolean(processAlive("app")), database: ownContainer() ? run("docker", ["inspect", "--format", "{{.State.Status}}", container]).trim() : "absent" }));
} else throw new Error("Usage: corepack yarn personal init|start|stop|status|backup");
