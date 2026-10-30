"use client";

import { use, useEffect, useLayoutEffect, useRef, useState } from "react";

import { toast } from "@/components/toast";
import { TrackSaveContext } from "@/components/save-tracker";
import { PendingSavesContext } from "@/components/save-boundary";
import { clearAutosaveDraft, readAutosaveDraft, sameDraftValue, writeAutosaveDraft } from "@/lib/autosave-draft";

export type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "error";
type RecoveryOptions<T> = { key: string; label: string; restore: (value: T) => void };

const COULD_NOT_SAVE =
  "Couldn't save your changes. They're still on this page, and saving will try again when you edit or leave the field.";

type AutosaverOptions<T> = {
  /** Persists a value. A Server Action's `{ ok: false, error }` counts as a failure. */
  save: (value: T) => Promise<unknown>;
  delay: number;
  onStatus: (status: AutosaveStatus, savedAt?: Date) => void;
  onFailure: (message: string) => void;
};

function failureMessage(result: unknown): string | null {
  if (
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    result.ok === false
  ) {
    return "error" in result && typeof result.error === "string" ? result.error : COULD_NOT_SAVE;
  }
  return null;
}

/**
 * The autosave logic without React. Changes are debounced, and only one save
 * runs at a time: changes made during a save are coalesced and sent after it,
 * so the newest value is always the one saved last and responses can't
 * arrive out of order. A failed save is retried once.
 */
export function createAutosaver<T>({ save: initialSave, delay, onStatus: initialStatus, onFailure }: AutosaverOptions<T>) {
  let save = initialSave;
  let onStatus = initialStatus;
  let pending: { value: T } | null = null; // changed, not yet sent
  let failed: { value: T } | null = null; // sent, not saved; retried on the next flush
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  const waiters = new Set<(saved: boolean) => void>();
  const settle = (saved: boolean) => {
    for (const resolve of waiters) resolve(saved);
    waiters.clear();
  };

  async function attempt(value: T): Promise<string | null> {
    try {
      return failureMessage(await save(value));
    } catch {
      return COULD_NOT_SAVE;
    }
  }

  async function run(value: T) {
    saving = true;
    let failure = await attempt(value);
    // Retry once, unless a newer change has replaced this value anyway.
    if (failure !== null && !pending) failure = await attempt(value);
    saving = false;

    if (pending) {
      // A newer change arrived during the save: send it now, unless its debounce is still running.
      if (timer === undefined) flush();
    } else if (failure !== null) {
      failed = { value };
      onStatus("error");
      onFailure(failure);
      settle(false);
    } else {
      onStatus("saved", new Date());
      settle(true);
    }
  }

  /** Records a change; it's saved once no further change comes for `delay` ms. */
  function change(value: T) {
    pending = { value };
    failed = null;
    onStatus("saving");
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  }

  /** Saves the latest change now instead of waiting for the debounce. */
  function flush(): Promise<boolean> {
    clearTimeout(timer);
    timer = undefined;
    if (saving) return new Promise((resolve) => waiters.add(resolve));
    const next = pending ?? failed;
    pending = null;
    failed = null;
    if (next) {
      const done = new Promise<boolean>((resolve) => waiters.add(resolve));
      onStatus("saving");
      void run(next.value);
      return done;
    }
    return Promise.resolve(true);
  }

  /** Uses a new save function from now on, e.g. one that closes over newer props. */
  function setSave(next: (value: T) => Promise<unknown>) {
    save = next;
  }

  return { change, flush, setSave, setStatusListener: (listener: typeof onStatus) => { onStatus = listener; },
    reportStatus: (status: AutosaveStatus) => onStatus(status),
    isDirty: () => saving || pending !== null || failed !== null };
}

/**
 * Saves `value` automatically, `delay` ms after it stops changing, for forms
 * without a Save button (PRD PRO-10). Typing is never blocked.
 *
 * Reload/close warns while writes are outstanding. Hiding the page and
 * unmounting also flush, but cannot guarantee delivery during unload. Call `flush` from `onBlur` to
 * save when the user leaves a field. When a save fails twice, an error toast
 * appears and the value stays in the form.
 *
 *     const { status, savedAt, flush } = useAutosave(basics, saveBasics);
 *     <form onBlur={flush}>…</form>
 *     <SavedIndicator status={status} savedAt={savedAt} />
 */
export function useAutosave<T>(
  value: T,
  save: (value: T) => Promise<unknown>,
  delay = 500,
  recovery?: RecoveryOptions<T>,
): { status: AutosaveStatus; savedAt: Date | null; flush: () => void } {
  const track = use(TrackSaveContext);
  const boundary = use(PendingSavesContext);
  const [identity] = useState(() => ({}));
  const report = useRef(track.report);
  const draft = useRef(recovery);
  const base = useRef(value);
  const lastSeen = useRef(value);
  const recoveryChecked = useRef(false);
  const conflict = useRef(false);
  const storageWarning = useRef(false);
  const [state, setState] = useState<{ status: AutosaveStatus; savedAt: Date | null }>({
    status: "idle",
    savedAt: null,
  });

  const [saver] = useState(() =>
    createAutosaver<T>({
      save,
      delay,
      onStatus: () => {},
      onFailure: toast,
    }),
  );

  // Always call the latest `save`, without restarting the autosaver.
  useLayoutEffect(() => {
    saver.setSave(save);
    report.current = track.report;
    draft.current = recovery;
    saver.setStatusListener((status, savedAt) => {
      setState((previous) => ({ status, savedAt: savedAt ?? previous.savedAt }));
      report.current?.(identity, status, savedAt);
      if (status === "saved" && !conflict.current) {
        base.current = lastSeen.current;
        if (draft.current) clearAutosaveDraft(draft.current.key);
      }
    });
  });

  useLayoutEffect(() => boundary?.register(saver, recovery?.key), [boundary, saver, recovery?.key]);

  // Save changes, but not the value the form started with.
  useLayoutEffect(() => {
    if (!recoveryChecked.current) {
      recoveryChecked.current = true;
      const options = draft.current;
      const recovered = options && readAutosaveDraft(options.key, value);
      if (options && recovered) {
        if (sameDraftValue(recovered.value, value)) clearAutosaveDraft(options.key);
        else if (sameDraftValue(recovered.base, value)) {
          options.restore(recovered.value);
          saver.change(recovered.value);
          toast("Recovered unsaved changes from this tab.");
        } else if (boundary) {
          conflict.current = true;
          saver.reportStatus("error");
          boundary.recover({
            key: options.key, label: options.label, current: value, recovered: recovered.value,
            resolve: (useDraft) => {
              conflict.current = false;
              if (useDraft) {
                options.restore(recovered.value);
                saver.change(recovered.value);
              } else {
                clearAutosaveDraft(options.key);
                saver.reportStatus("idle");
              }
            },
          });
        }
      }
    }
    if (Object.is(lastSeen.current, value)) return;
    lastSeen.current = value;
    const options = draft.current;
    if (options && !conflict.current && !writeAutosaveDraft(options.key, { base: base.current, value }) && !storageWarning.current) {
      storageWarning.current = true;
      toast("This browser couldn't keep a recovery copy. Wait for Saved before reloading.");
    }
    saver.change(value);
  }, [saver, value, boundary, identity]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") saver.flush();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!saver.isDirty()) return;
      event.preventDefault();
      event.returnValue = "";
      void saver.flush();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", saver.flush);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", saver.flush);
      window.removeEventListener("beforeunload", beforeUnload);
      saver.flush(); // leaving the page, e.g. navigating to another screen
    };
  }, [saver]);

  const [flush] = useState(() => () => { void saver.flush(); });
  return { status: state.status, savedAt: state.savedAt, flush };
}
