"use client";

import { createContext, use, useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AutosaveStatus } from "@/hooks/use-autosave";
import { PendingSavesContext } from "./save-boundary";
import { autosaveDraftSnapshot, emptyDraftSnapshot, subscribeAutosaveDrafts } from "@/lib/autosave-draft";

type Track = {
  <T>(save: Promise<T>, key?: unknown): Promise<T>;
  report?: (key: unknown, status: AutosaveStatus, savedAt?: Date) => void;
};

export const TrackSaveContext = createContext<Track>((save) => save);

/** Immediate actions share a retry identity per caller; independent fields can supply a key. */
export function useTrackSave(): Track {
  const track = use(TrackSaveContext);
  const [identity] = useState(() => ({}));
  return useCallback(<T,>(save: Promise<T>, key: unknown = identity) => track(save, key), [track, identity]);
}

const failed = (result: unknown) =>
  typeof result === "object" && result !== null && "ok" in result && result.ok === false;

/** A page is saved only when every autosaver and immediate request has settled successfully. */
export function useSaveTracker(): { status: AutosaveStatus; savedAt: Date | null; track: Track } {
  const boundary = use(PendingSavesContext);
  const drafts = useSyncExternalStore(subscribeAutosaveDrafts, autosaveDraftSnapshot, emptyDraftSnapshot);
  const [pending, setPending] = useState(0);
  const [states, setStates] = useState(() => new Map<unknown, AutosaveStatus>());
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const versions = useRef(new Map<unknown, object>());
  const report = useCallback((key: unknown, status: AutosaveStatus, date?: Date) => {
    setStates((previous) => new Map(previous).set(key, status));
    if (date) setSavedAt(date);
  }, []);
  const track = useMemo<Track>(() => {
    const run: Track = async (save, key = {}) => {
      const version = {};
      versions.current.set(key, version);
      setPending((count) => count + 1);
      report(key, "saving");
      let active = true;
      const detach = boundary?.register({
        isDirty: () => active,
        flush: () => save.then((result) => !failed(result), () => false),
      });
      try {
        const result = await save;
        if (versions.current.get(key) === version) report(key, failed(result) ? "error" : "saved", failed(result) ? undefined : new Date());
        return result;
      } catch (error) {
        if (versions.current.get(key) === version) report(key, "error");
        throw error;
      } finally {
        active = false;
        detach?.();
        setPending((count) => count - 1);
      }
    };
    run.report = report;
    return run;
  }, [boundary, report]);
  const values = [...states.values()];
  const status = pending > 0 || values.includes("saving") ? "saving"
    : values.includes("error") ? "error" : drafts !== "[]" ? "pending" : savedAt ? "saved" : "idle";
  return { status, savedAt, track };
}
