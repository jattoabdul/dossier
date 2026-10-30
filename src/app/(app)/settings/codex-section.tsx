"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { toast, toastResult } from "@/components/toast";
import { copyText } from "@/lib/copy-text";
import { SettingsSectionIntro } from "./settings-screen";
import { setCodexConnector } from "./codex-actions";
export function CodexSection({ enabled, command, prompt }: { enabled: boolean; command: string; prompt: string }) {
  const [on, setOn] = useState(enabled);
  const [busy, setBusy] = useState(false);
  async function turn(next: boolean) {
    setBusy(true);
    const result = toastResult(await setCodexConnector({ on: next }));
    if (result.ok) setOn(next);
    setBusy(false);
  }
  return <>
    <SettingsSectionIntro title="Codex connector">Use your profile, career sources and applications in Codex. Codex can save tailored drafts and update application statuses through this local connection.</SettingsSectionIntro>
    <section className="rounded-card bg-surface p-6 space-y-4">
      <Toggle label="Let Codex connect" checked={on} disabled={busy || !command} onCheckedChange={value => void turn(value)} description={on ? "On. Registered Codex sessions can access Dossier on this machine." : "Off. Turn on the connection, then register it with Codex."} />
      {on && <><p className="text-sm text-muted">The local connection uses your Codex account. It does not require an OpenAI API key in Dossier. Content you ask Codex to read becomes part of that Codex session, including personal details in source documents.</p>
      <pre className="whitespace-pre-wrap break-all rounded-control bg-input p-4 text-xs">{command}</pre>
      <Button variant="secondary" onClick={() => void copyText(command).then(ok => toast(ok ? "Setup command copied." : "Select and copy the command."))}>Copy setup command</Button>
      <p className="text-sm text-muted">Run this command once in Terminal, then open a new Codex chat or reload its MCP connections. Keep Dossier running while you use it.</p>
      <Button variant="secondary" disabled={busy} onClick={() => void turn(true)}>Rotate connection credential</Button></>}
    </section>
    <section className="rounded-card bg-surface p-6 space-y-4">
      <h3 className="font-serif text-xl">Continue in Codex</h3>
      <p className="text-sm text-muted">Copy this request into a Codex chat with the Dossier tools available. Review the resulting drafts in Applications.</p>
      <pre className="whitespace-pre-wrap rounded-control bg-input p-4 text-sm">{prompt}</pre>
      <Button variant="secondary" onClick={() => void copyText(prompt).then(ok => toast(ok ? "Request copied." : "Select and copy the request."))}>Copy request</Button>
    </section>
    <section className="space-y-3 text-sm">
      <h3 className="font-serif text-xl">Finish your setup</h3>
      <p><Link className="underline" href="/profile">Review your profile</Link> and <Link className="underline" href="/library">review imported sources and statuses</Link>. Only confirm application statuses you know.</p>
      <p><Link className="underline" href="/settings?section=google">Google</Link> is optional for Gmail and Calendar. Existing Google Docs links open with your normal Google account.</p>
      <p><Link className="underline" href="/settings?section=ai">OpenAI API settings</Link> are separate: add an API key only if you want Dossier itself to run AI tasks. Codex work uses the connector above. Automated job search needs a provider in <Link className="underline" href="/settings?section=jobs">Job search</Link>.</p>
    </section>
  </>;
}
