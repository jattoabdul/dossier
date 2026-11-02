# Local personal career system

Open **http://127.0.0.1:3401**. The password is in `.local-personal/LOGIN.md` (private, mode 0600). Use the personal instance for real work. The synthetic demo has its own database and configuration at port 3400.

From the repository root, with Node 24 selected:

```sh
corepack yarn personal status
corepack yarn personal start
corepack yarn personal backup
corepack yarn personal stop
```

After source changes, stop the app, build with the existing private configuration supplied as process environment, and restart it. The launcher does not export its configuration to an unrelated build command. `personal init` applies migrations and built-in themes; it does not seed sample people or applications. Do not use demo/reset seed flags against the personal database.

## Set your own persistent password

The personal launcher reads `.local-personal/env.json`. A project-root `.env` does not override the values supplied by this launcher. `DOSSIER_PASSWORD` must contain an Argon2id hash, never the plain password.

1. Run `corepack yarn hash-password` from the repository root. Enter your chosen password twice at the hidden prompts.
2. Copy the generated hash into the existing `DOSSIER_PASSWORD` string in `.local-personal/env.json`. Preserve every other setting, especially `DATABASE_URL` and `DOSSIER_SECRET`.
3. Run `corepack yarn personal stop`, then `corepack yarn personal start`.
4. Sign in using the password you chose, not the hash. Update `.local-personal/LOGIN.md` to remove the old generated password, and keep your chosen password in your password manager.
5. Changing the password signs existing sessions out and invalidates the Codex credential. After signing back in, use **Settings → Codex connector → Rotate connection credential**. The registered bridge reads the new credential automatically.

The launcher generates a password only when its configuration does not yet exist. Normal initialization and restarts preserve it. Keep `.local-personal/` intact. The demo on port 3400 has a separate password. Both instances use the same browser cookie name on the same host, so switching between them can also cause a sign-in prompt; that does not change either password.

## Data and first review

Set `DOSSIER_CAREER_ROOT` in the private launcher configuration to the directory containing your existing career files. Review the profile and each preparation collection before importing it. Keep uncertain claims, application statuses and submission dates unresolved until you can verify them.

Use **Career library** to open indexed originals and review preparation collections. A folder can contain historical roles, drafts or templates; it does not automatically become a submitted application. The current version supports one reviewed application link per collection. Additional roles can be created through New application or Codex while retaining source references.

The base résumé is generated from the reviewed profile. Original PDFs and letters stay available as source documents; they are not automatically converted into editable document units. The library is an index, not a two-way synchronization service.

## Codex

**Settings → Codex connector** enables, rotates or revokes the local connection. After enabling it, register the displayed command with Codex. Open a new Codex chat or reload MCP connections to make the tools available.

The connector uses a local stdio bridge, pinned to Node 24, with a private credential file in `.local-personal/`. The server stores a keyed digest, tied to the installation secret and password hash. Turning the connector off revokes access. Rotating it invalidates the old credential; the bridge reads the current file on every request. The credential is not included in JSON exports, browser output or command arguments.

Codex can read the profile and applications, list and explicitly read indexed text sources, search through a configured job source, save scores and new tailored drafts, and update statuses. The imported source content can include contact details and private notes; content requested through Codex becomes part of that session. The library tools are only exposed through the Codex endpoint, not silently added to the existing Claude connector.

**New application → Write it with Codex** saves the posting locally and offers a short request to copy into Codex. The resulting documents are saved as drafts with `codex-chat` provenance and Dossier's factual checks. Find jobs scoring can use the same handoff. No connector tool sends emails, submits applications, deletes records or writes the original source files. Ask Codex explicitly before changing statuses.

The current connector saves new document drafts; it does not yet rewrite an existing document in place. Dossier's in-app refinement and scheduled AI agent still require a configured API/local model. OpenAI-compatible provider support already exists in **Settings → AI provider**. A Codex account and an API key are separate setup paths.

Official connection reference: [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Optional setup requiring the owner

1. **Google Docs:** existing tab links work through the normal signed-in browser. No Dossier OAuth connection is needed just to open them. There is no automatic résumé-tab synchronization.
2. **Gmail/Calendar:** in Settings → Google, supply a Google OAuth Web application client ID and secret, register the exact redirect shown (`http://127.0.0.1:3401/api/google/callback` for this instance), and complete Google's consent screen yourself. The app's Google feature is for Gmail/Calendar, not Google Docs. Reading and calendar automation are off initially. Review the requested permissions before enabling each feature.
3. **Email:** sending is explicitly disabled by `DOSSIER_EMAIL_SEND=off`. Leave it off until the separate send-reliability work is completed and sending is authorized. Existing Google credential consent does not override this guard.
4. **Job search:** select and configure a provider in Settings → Job search before using the built-in search. Pasting a posting and working with Codex does not require one. The scheduled job agent is off.
5. **In-app AI:** only add an OpenAI API key/model if you want Dossier to invoke that provider itself. Keep credentials out of source files, exports and chats. An OpenAI-compatible local model can be configured later.

## Indexing and backups

Store reviewed inputs and generated plans in `.local-personal/imports/`. The importer reads `profile-reviewed.json`, `resume-tabs.json`, `resume-current.json` and `resume-base.json` from this private directory. These are operator-supplied inputs, not sample data distributed by the fork. Review their structure in `scripts/career-import.mts` before preparing an import.

An optional private `source-layout.json` selects the tracker filename, tab-title prefix mappings and time zone. Defaults are `job-search-tracker.md`, no explicit tab mappings and `UTC`. Example with fictional names:

```json
{
  "trackerPath": "job-search-tracker.md",
  "tabMappings": {"Example Company": "example-company"},
  "workTimeZone": "UTC"
}
```

The initial importer is deliberately limited to an empty personal database:

```sh
corepack yarn tsx scripts/career-import.mts index
# Review .local-personal/imports/IMPORT-REVIEW.md and index-plan.json first.
corepack yarn tsx scripts/career-import.mts apply <exact-reviewed-plan-sha256>
```

Applying the identical imported plan is a no-op; a different plan cannot overwrite an occupied database. A changed source is refused until its new version is deliberately reviewed and re-indexed. An incremental refresh workflow is future work; do not clear the database to refresh a link. Original folders remain the authority during this pilot.

Settings → Your data exports schema 6, including source references, review records and import receipts, and reads older schema versions. Root filesystem locations are installation configuration and are never trusted from imported data. Reading a source requires an indexed ID, a configured root, a regular file with no symlink components, and the recorded checksum. HTML/SVG/binary content is never executed as an application page.

`personal backup` creates a PostgreSQL custom-format dump with 0600 permissions in `.local-personal/backups/`. JSON and database backups retain the index, not the original files or remote Google Docs. Back up those originals and `.local-personal/` separately to a private destination. Never commit this directory or upload it to the public fork.

The personal service and database bind to loopback. Review current dependency advisories and email send reliability before expanding access or enabling sending. Local verification does not establish readiness for public-network exposure.

### Email send review and recovery

Sending remains disabled until the owner separately approves enabling it. Google consent alone does not enable sending.

The hardened send flow first saves an immutable review containing the sender, recipients, subject, full message and exact PDF attachments. Opening the review waits for pending autosaves. The final confirmation accepts that review's ID; it does not reconstruct an email from documents that may have changed. Each attempt has a stable Message-ID and a durable database claim. Repeated or concurrent confirmations cannot initiate another POST for the same attempt. Intentional repeat sends require a new review.

If Gmail's response is lost, malformed, or cannot be recorded locally, the attempt stays blocked from resending. **Review send status → Check send status** only reads Gmail or repairs the local record from an already saved provider receipt. An empty, unavailable or mismatching search never proves that an email was not sent. Such attempts remain blocked for manual review; there is no automatic retry or “assume not sent” shortcut. Acceptance by Gmail is not proof of inbox delivery to the recipient.

Unresolved attempts survive application deletion. Bulk import and deletion refuse to erase pending send history, and a refused deletion preserves the Google connection. Frozen email/PDF snapshots are private database data; they are excluded from portable JSON exports along with other Gmail data. A full PostgreSQL backup retains this send history. Importing JSON requires fresh review before any send and must not be treated as restoration of an in-flight sending queue.

Tests use disposable synthetic databases and a fake Gmail endpoint. Passing them does not constitute approval to enable real sending.
