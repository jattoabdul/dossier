# Local synthetic demo

This fork has a local evaluation mode using Jane Doe's fictional profile, sample applications and a deterministic OpenAI-compatible stand-in. It exercises the application workflow without a real model, provider key or paid API call. The stand-in returns fixture content; it does not understand arbitrary postings like a real model would.

## Start and stop

Prerequisites: Node 24.15.0, Corepack/Yarn and Docker. Run commands from this repository. The runtime versions are recorded in `.tool-versions` and `.node-version`.

```sh
YARN_ENABLE_SCRIPTS=false corepack yarn install --immutable
corepack yarn prisma generate
corepack yarn demo init
NEXT_TELEMETRY_DISABLED=1 corepack yarn build
corepack yarn demo start
corepack yarn demo status
```

`init` creates a dedicated PostgreSQL container and volume, applies migrations, and seeds sample data. It refuses to replace an existing profile. Do not rerun it to reset a demo you have edited.

Open <http://127.0.0.1:3400>. The randomly generated login is in the ignored, owner-readable `.local-demo/LOGIN.md` file. There is no username. Settings and logs live under `.local-demo/`, which is restricted to the local owner. Keep this directory out of Git and shared folders.

```sh
corepack yarn demo stop
corepack yarn demo start
```

Stopping retains the database volume and files. Start Docker again before restarting the demo after a machine restart. Rebuild after source changes while the demo is stopped. No automatic login service or startup task is installed.

PDF rendering needs Chromium matching the installed Playwright version. If it is missing, install it with `corepack yarn exec playwright install chromium`.

## Boundaries

| Component | Local address or storage |
|---|---|
| Production app built from this checkout | `127.0.0.1:3400` |
| Mock AI | `127.0.0.1:3999` |
| Synthetic PostgreSQL | `127.0.0.1:35433`, database `dossier_demo` |
| Docker container / volume | `dossier-local-demo` / `dossier-local-demo-pgdata` |
| Backup directory | `.local-demo/data/backups` |

`DOSSIER_DEMO_MODE=on` blocks server-side fetch destinations except the mock AI and rejects redirects. Google connection, email sending and the Claude connector are disabled. Telemetry, live job search and automatic discovery are off. This is an application guard, not an operating-system network sandbox. Browser links and non-fetch networking are not globally sandboxed.

Use synthetic information in this demo. Do not point it at existing career folders, paste real credentials, or simply turn off demo mode to convert its sample records into personal records. Create a separate personal database for the later real-data pilot.

## Credentials, imports and backups

Imports preserve this machine's AI provider, endpoint, model, job-source connection choices and automation activation settings. Switching an AI provider or endpoint origin clears the saved key. An environment key is used by saved settings only for the same provider and origin. Configure credentials separately after moving to another machine.

Backups are complete JSON exports, published atomically with owner-only file permissions. Same-second backups do not overwrite one another. Scheduled backups omit plaintext provider keys. The optional key-inclusive export contains secrets and must be handled accordingly. Keep the local environment and original files separately; a JSON export is not a full machine disaster-recovery backup.

Imported or generated text remains untrusted. The claim checker uses candidate facts rather than job requirements, but is a heuristic and may flag harmless employer mentions. Review drafts before using them.

## Separate personal setup

Use [the personal-instance guide](LOCAL_PERSONAL.md) for a separate database, a read-only career library and the optional Codex connector. In-app AI uses an independently configured OpenAI-compatible or other supported provider. Keep model credentials and permitted data/cost scope specific to each instance.

Before relying on any instance, review current dependency advisories, verify backup recovery, and resolve email send reliability before enabling sending. This demo does not configure public-network exposure.
