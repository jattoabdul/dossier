import { describe, expect, it, vi } from "vitest";
import { createPendingSaves } from "./pending-saves";

describe("pending save coordinator", () => {
  it("keeps a controller reattached during Strict Mode cleanup", async () => {
    const saves = createPendingSaves();
    const entry = { isDirty: () => false, flush: async () => true };
    saves.register(entry, "profile")();
    saves.register(entry, "profile");
    await Promise.resolve();
    expect(saves.hasKey("profile")).toBe(true);
  });

  it("releases an unmounted failed controller after a successful retry", async () => {
    const saves = createPendingSaves();
    let dirty = true;
    const flush = vi.fn().mockResolvedValue(false);
    saves.register({ isDirty: () => dirty, flush }, "profile")();
    await Promise.resolve();
    expect(saves.hasKey("profile")).toBe(true);
    flush.mockImplementation(async () => { dirty = false; return true; });
    expect(await saves.flush()).toBe(true);
    expect(saves.hasKey("profile")).toBe(false);
  });
  it("retains a detached form until its outstanding write is acknowledged", async () => {
    const saves = createPendingSaves();
    const result = Promise.withResolvers<boolean>();
    let dirty = true;
    const detach = saves.register({ isDirty: () => dirty, flush: () => result.promise });
    detach();
    expect(saves.isDirty()).toBe(true);
    dirty = false;
    result.resolve(true);
    await result.promise;
    expect(saves.isDirty()).toBe(false);
    expect(await saves.flush()).toBe(true);
  });
  it("retains failure for an explicit retry and drains a newly queued form", async () => {
    const saves = createPendingSaves();
    let dirty = true;
    const flush = vi.fn().mockResolvedValue(false);
    saves.register({ isDirty: () => dirty, flush });
    expect(await saves.flush()).toBe(false);
    expect(saves.isDirty()).toBe(true);
    let nextDirty = true;
    const nextSave = vi.fn(async () => { nextDirty = false; return true; });
    flush.mockImplementation(async () => {
      dirty = false;
      saves.register({ isDirty: () => nextDirty, flush: nextSave });
      return true;
    });
    expect(await saves.flush()).toBe(true);
    expect(nextSave).toHaveBeenCalledOnce();
    expect(saves.isDirty()).toBe(false);
  });
});
