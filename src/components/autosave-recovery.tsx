"use client";

import { AlertDialog } from "radix-ui";
import { Button } from "./ui/button";
import { sameDraftValue } from "@/lib/autosave-draft";

export type AutosaveRecovery = {
  key: string;
  label: string;
  current: unknown;
  recovered: unknown;
  resolve: (useDraft: boolean) => void;
};

function display(value: unknown): string {
  if (value === null || value === "") return "Empty";
  if (Array.isArray(value)) return value.map(display).join("\n");
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, item]) => `${key}: ${display(item)}`).join("\n");
  return String(value);
}

/** Conflicting drafts are never silently written over a newer server value. */
export function AutosaveRecoveryDialog({ recovery }: { recovery: AutosaveRecovery }) {
  const current = typeof recovery.current === "object" && recovery.current !== null ? recovery.current as Record<string, unknown> : { Value: recovery.current };
  const recovered = typeof recovery.recovered === "object" && recovery.recovered !== null ? recovery.recovered as Record<string, unknown> : { Value: recovery.recovered };
  return <AlertDialog.Root open>
    <AlertDialog.Portal>
      <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
      <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[min(680px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto rounded-dialog bg-card p-6">
        <AlertDialog.Title className="font-serif text-[22px] leading-tight">Review recovered changes: {recovery.label}</AlertDialog.Title>
        <AlertDialog.Description className="text-sm text-muted">This tab has unsaved changes, and the saved version has also changed. Choose which version to keep.</AlertDialog.Description>
        <div className="flex flex-col gap-5">
          {Object.keys(recovered).filter((key) => !sameDraftValue(current[key], recovered[key])).map((key) => <div key={key}>
            <h3 className="mb-2 font-medium capitalize">{key.replace(/([A-Z])/g, " $1")}</h3>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div className="rounded-control bg-paper p-3"><dt className="mb-1 text-muted">Saved version</dt><dd className="whitespace-pre-wrap break-words">{display(current[key])}</dd></div>
              <div className="rounded-control bg-paper p-3"><dt className="mb-1 text-muted">Recovered changes</dt><dd className="whitespace-pre-wrap break-words">{display(recovered[key])}</dd></div>
            </dl>
          </div>)}
        </div>
        <div className="flex flex-wrap justify-end gap-3">
          <AlertDialog.Cancel asChild><Button variant="secondary" onClick={() => recovery.resolve(false)}>Keep saved version</Button></AlertDialog.Cancel>
          <AlertDialog.Action asChild><Button onClick={() => recovery.resolve(true)}>Use recovered changes</Button></AlertDialog.Action>
        </div>
      </AlertDialog.Content>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}
