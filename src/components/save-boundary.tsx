"use client";

import { createContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import Link from "next/link";
import { createPendingSaves } from "@/lib/pending-saves";
import { autosaveDraftSnapshot, draftDestination, emptyDraftSnapshot, subscribeAutosaveDrafts } from "@/lib/autosave-draft";
import { toast } from "./toast";
import { AutosaveRecoveryDialog, type AutosaveRecovery } from "./autosave-recovery";

type SaveBoundaryState = ReturnType<typeof createPendingSaves> & { recover: (recovery: AutosaveRecovery) => void };
export const PendingSavesContext = createContext<SaveBoundaryState | null>(null);

/** Wait for acknowledged writes before a link or sign-out can leave the form. */
export function SaveBoundary({ children }: { children: ReactNode }) {
  const [recoveries, setRecoveries] = useState<AutosaveRecovery[]>([]);
  const [saves] = useState<SaveBoundaryState>(() => ({
    ...createPendingSaves(),
    recover: (recovery) => setRecoveries((current) => [...current.filter((entry) => entry.key !== recovery.key), {
      ...recovery,
      resolve: (useDraft) => {
        recovery.resolve(useDraft);
        setRecoveries((current) => current.filter((entry) => entry.key !== recovery.key));
      },
    }]),
  }));
  useSyncExternalStore(saves.subscribe, saves.snapshot, () => 0);
  const drafts = useSyncExternalStore(subscribeAutosaveDrafts, autosaveDraftSnapshot, emptyDraftSnapshot);
  const destinations = new Map((JSON.parse(drafts) as string[]).filter((key) => !saves.hasKey(key)).map((key) => {
    const destination = draftDestination(key);
    return [destination.href, destination];
  }));
  useEffect(() => {
    let replaying = false;
    let navigation = 0;
    const leave = async (resume: () => void) => {
      const request = ++navigation;
      // Let blur normalization and its layout effects finish before draining.
      await Promise.resolve();
      if (!(await saves.flush())) {
        toast("Some changes couldn't be saved. Please try again before leaving.", {
          action: { label: "Retry saving", onClick: () => { void saves.flush(); } },
        });
        return;
      }
      if (request !== navigation) return;
      replaying = true;
      try { resume(); } finally { replaying = false; }
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!saves.isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
      void saves.flush();
    };
    const click = (event: MouseEvent) => {
      if (replaying || !saves.isDirty() || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(link instanceof HTMLAnchorElement) || link.download || (link.target && link.target !== "_self")) return;
      const destination = new URL(link.href);
      if (destination.pathname === location.pathname && destination.search === location.search && destination.hash) return;
      event.preventDefault();
      event.stopPropagation();
      void leave(() => link.click());
    };
    const submit = (event: SubmitEvent) => {
      if (replaying || !saves.isDirty() || event.defaultPrevented || !(event.target instanceof HTMLFormElement)) return;
      const form = event.target;
      event.preventDefault();
      event.stopPropagation();
      void leave(() => form.requestSubmit(event.submitter));
    };
    // The Navigation API covers browser Back/Forward before Next changes routes.
    // Older browsers still have the unload guard and per-tab draft recovery.
    const historyNavigation = (window as unknown as { navigation?: EventTarget & {
      traverseTo: (key: string) => { finished: Promise<unknown> };
    } }).navigation;
    const traverse = (raw: Event) => {
      const event = raw as Event & { navigationType: string; destination: { sameDocument: boolean; key: string } };
      if (replaying || !saves.isDirty() || !event.cancelable || event.navigationType !== "traverse" || !event.destination.sameDocument) return;
      event.preventDefault();
      void leave(() => { void historyNavigation?.traverseTo(event.destination.key).finished.catch(() => {}); });
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    document.addEventListener("submit", submit, true);
    historyNavigation?.addEventListener("navigate", traverse);
    return () => {
      navigation++;
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
      document.removeEventListener("submit", submit, true);
      historyNavigation?.removeEventListener("navigate", traverse);
    };
  }, [saves]);
  return <PendingSavesContext value={saves}>
    {children}
    {destinations.size > 0 && <aside aria-label="Unsaved changes" className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-xl flex-wrap items-center gap-3 rounded-control bg-card p-4 text-sm shadow-menu">
      <span>Unsaved changes are available in this tab.</span>
      {[...destinations.values()].map(({ href, label }) => <Link key={href} href={href} className="font-medium capitalize underline underline-offset-3">Review {label}</Link>)}
    </aside>}
    {recoveries[0] && <AutosaveRecoveryDialog recovery={recoveries[0]} />}
  </PendingSavesContext>;
}
