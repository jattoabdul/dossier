import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAllAutosaveDrafts, clearAutosaveDraft, readAutosaveDraft, writeAutosaveDraft } from "./autosave-draft";

afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe("opted-in tab drafts", () => {
  it("clears only autosave copies when deleting all data", () => {
    sessionStorage.setItem("unrelated", "keep");
    writeAutosaveDraft("a", { base: "", value: "first" });
    writeAutosaveDraft("b", { base: "", value: "second" });
    clearAllAutosaveDrafts();
    expect(Object.keys(sessionStorage)).toEqual(["unrelated"]);
  });
  it("handles missing, malformed and incompatible drafts without applying them", () => {
    expect(readAutosaveDraft("x", { id: "a", text: "" })).toBeNull();
    for (const raw of ["{", "[]", '{"base":1}', JSON.stringify({ base: { id: "b", text: "" }, value: { id: "b", text: "wrong record" } }), JSON.stringify({ base: { id: "a", text: "" }, value: { id: "a", text: 4 } })]) {
      sessionStorage.setItem("dossier:autosave:v1:x", raw);
      expect(readAutosaveDraft("x", { id: "a", text: "" })).toBeNull();
    }
  });
  it("preserves nullable-field conflicts for review instead of silently dropping them", () => {
    const draft = { base: { id: "a", year: null, tags: [] }, value: { id: "a", year: 2025, tags: ["TypeScript"] } };
    expect(writeAutosaveDraft<{ id: string; year: number | null; tags: string[] }>("x", draft)).toBe(true);
    expect(readAutosaveDraft("x", { id: "a", year: 2026, tags: ["Rust"] })).toEqual(draft);
    clearAutosaveDraft("x");
    expect(readAutosaveDraft("x", {})).toBeNull();
  });
  it("tolerates unavailable browser storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("disabled"); });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("disabled"); });
    expect(writeAutosaveDraft("x", { base: "", value: "edit" })).toBe(false);
    expect(readAutosaveDraft("x", "")).toBeNull();
    expect(() => clearAutosaveDraft("x")).not.toThrow();
  });
});
