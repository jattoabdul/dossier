/** Save controllers outlive a collapsed form until its last write is acknowledged. */
export type PendingSave = {
  isDirty: () => boolean;
  flush: () => Promise<boolean>;
};

export function createPendingSaves() {
  const entries = new Set<PendingSave>();
  const keys = new Map<PendingSave, string>();
  const detached = new Set<PendingSave>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const notify = () => { revision++; listeners.forEach((listener) => listener()); };
  const prune = () => {
    for (const entry of detached) if (!entry.isDirty()) {
      entries.delete(entry); keys.delete(entry); detached.delete(entry); notify();
    }
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => revision,
    hasKey: (key: string) => [...keys.values()].includes(key),
    register(entry: PendingSave, key?: string) {
      entries.add(entry);
      detached.delete(entry);
      if (key) keys.set(entry, key);
      notify();
      return () => {
        detached.add(entry);
        // Keep the unload guard while an unmounted form drains its queue.
        void entry.flush().then(prune);
      };
    },
    isDirty: () => [...entries].some((entry) => entry.isDirty()),
    async flush(): Promise<boolean> {
      // A save can enqueue another edit, or mount another form, before resolving.
      while ([...entries].some((entry) => entry.isDirty())) {
        const results = await Promise.all([...entries].filter((entry) => entry.isDirty()).map((entry) => entry.flush()));
        prune();
        if (results.some((saved) => !saved)) return false;
      }
      return true;
    },
  };
}
