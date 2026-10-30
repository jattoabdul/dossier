// Local synthetic demo lifecycle. Never uses the career folders or a real provider key.
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/lib/auth/password-hash";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, ".local-demo");
const container = "dossier-local-demo";
const volume = "dossier-local-demo-pgdata";
const label = "dev.dossier.purpose=synthetic-demo";
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
  if (!existsSync(envFile)) throw new Error("Run `corepack yarn demo init` first.");
  return JSON.parse(readFileSync(envFile, "utf8"));
}
function childEnv(): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH!, HOME: process.env.HOME!, NODE_ENV: "production", ...configuration() };
}
function ownContainer(): boolean {
  let owner: string;
  try { owner = run("docker", ["inspect", "--format", '{{ index .Config.Labels "dev.dossier.purpose" }}', container]).trim(); }
  catch { return false; }
  if (owner !== "synthetic-demo") throw new Error("A container with this name already exists and is not this demo.");
  return true;
}
async function databaseReady() {
  for (let i = 0; i < 50; i++) {
    try { run("docker", ["exec", container, "pg_isready", "-U", "dossier_demo", "-d", "dossier_demo"]); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  throw new Error("Demo database did not become ready.");
}
function processAlive(name: string): number | null {
  const filename = path.join(dir, `${name}.pid`);
  if (!existsSync(filename)) return null;
  const pid = Number(readFileSync(filename, "utf8"));
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("Invalid demo PID file.");
  try {
    const command = run("ps", ["-p", String(pid), "-o", "command="]);
    const marker = name === "app" ? "next-server" : "e2e/fake-ai.mts";
    if (!command.includes(marker)) throw new Error("Demo PID belongs to another process; inspect before stopping.");
    const cwd = run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
    if (!cwd.split("\n").some((line) => line === `n${root}` || line === `n${root}/.next/standalone`)) {
      throw new Error("Demo PID belongs to another directory; inspect before stopping.");
    }
    return pid;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Demo PID")) throw error;
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
    if (ownContainer()) throw new Error("Demo container exists but its local configuration is missing. Restore it before continuing.");
    const password = randomBytes(18).toString("base64url");
    const dbPassword = randomBytes(24).toString("hex");
    writePrivate("postgres.env", `POSTGRES_USER=dossier_demo\nPOSTGRES_DB=dossier_demo\nPOSTGRES_PASSWORD=${dbPassword}\n`);
    writePrivate("env.json", JSON.stringify({
      DATABASE_URL: `postgresql://dossier_demo:${dbPassword}@127.0.0.1:35433/dossier_demo`,
      DOSSIER_PASSWORD: await hashPassword(password), DOSSIER_SECRET: randomBytes(32).toString("hex"),
      DOSSIER_DATA_DIR: path.join(dir, "data"), DOSSIER_DEMO_MODE: "on", DOSSIER_TELEMETRY: "off",
      DOSSIER_JOBS_SOURCE: "off", DOSSIER_JOBS_ARBEITSAGENTUR: "off",
      DOSSIER_AI_PROVIDER: "openai", DOSSIER_AI_URL: "http://127.0.0.1:3999/v1", DOSSIER_AI_MODEL: "fake-model",
      HOSTNAME: "127.0.0.1", PORT: "3400", FAKE_AI_PORT: "3999", NEXT_TELEMETRY_DISABLED: "1",
    }, null, 2));
    writePrivate("LOGIN.md", `# Synthetic demo login\n\nAddress: http://127.0.0.1:3400\n\nPassword: \`${password}\`\n\nThis login is local to the synthetic demo. No real OpenAI key is configured.\n`);
  }
  if (!ownContainer()) {
    run("docker", ["run", "-d", "--name", container, "--label", label, "--env-file", path.join(dir, "postgres.env"),
      "--publish", "127.0.0.1:35433:5432", "--volume", `${volume}:/var/lib/postgresql`, "--memory", "512m", "--cpus", "1", "postgres:18-alpine"]);
  } else run("docker", ["start", container]);
  await databaseReady();
  const log = openSync(path.join(dir, "setup.log"), "a", 0o600);
  try {
    for (const args of [["node_modules/prisma/build/index.js", "migrate", "deploy"], ["node_modules/tsx/dist/cli.mjs", "prisma/seed.ts", "--demo"]]) {
      execFileSync(process.execPath, args, { cwd: root, env: childEnv(), stdio: ["ignore", log, log] });
    }
  } finally { closeSync(log); }
  console.log("Synthetic database initialized. Login is in .local-demo/LOGIN.md. Build the app, then run `corepack yarn demo start`.");
} else if (command === "start") {
  configuration();
  if (!existsSync(path.join(root, ".next/standalone/server.js"))) throw new Error("Run `corepack yarn build` first.");
  if (!ownContainer()) throw new Error("Demo database is missing. Run init first.");
  run("docker", ["start", container]);
  await databaseReady();
  cpSync("public", ".next/standalone/public", { recursive: true });
  cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
  launch("mock-ai", ["e2e/fake-ai.mts"]);
  launch("app", [".next/standalone/server.js"]);
  console.log("Demo starting at http://127.0.0.1:3400. Login: .local-demo/LOGIN.md. Logs: .local-demo/*.log.");
} else if (command === "stop") {
  for (const name of ["app", "mock-ai"]) {
    const pid = processAlive(name);
    if (pid) process.kill(pid, "SIGTERM");
  }
  if (ownContainer()) run("docker", ["stop", container]);
  console.log("Demo stopped. Database volume, backups and configuration retained.");
} else if (command === "status") {
  console.log(JSON.stringify({ app: Boolean(processAlive("app")), mockAi: Boolean(processAlive("mock-ai")), database: ownContainer() ? run("docker", ["inspect", "--format", "{{.State.Status}}", container]).trim() : "absent" }));
} else throw new Error("Usage: corepack yarn demo init|start|stop|status");
