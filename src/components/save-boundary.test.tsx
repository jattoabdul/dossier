import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutosave } from "@/hooks/use-autosave";
import { writeAutosaveDraft } from "@/lib/autosave-draft";
import { SaveBoundary } from "./save-boundary";
import { TrackSaveContext, useSaveTracker } from "./save-tracker";
import { SavedIndicator } from "./saved-indicator";

vi.mock("./toast", () => ({ toast: vi.fn() }));

function Form({ save, initial = "original", recover = true }: { save: (value: string) => Promise<unknown>; initial?: string; recover?: boolean }) {
  const [value, setValue] = useState(initial);
  const { flush } = useAutosave(value, save, 500, recover ? { key: "test", label: "Name", restore: setValue } : undefined);
  return <input aria-label="Name" value={value} onChange={(event) => setValue(event.target.value)} onBlur={flush} />;
}
function Page(props: Parameters<typeof Form>[0]) {
  const saves = useSaveTracker();
  return <TrackSaveContext value={saves.track}><SavedIndicator status={saves.status} savedAt={saves.savedAt} /><Form {...props} /></TrackSaveContext>;
}

describe("save boundary and reload recovery", () => {
  beforeEach(() => { vi.useFakeTimers(); sessionStorage.clear(); });
  afterEach(() => { vi.useRealTimers(); sessionStorage.clear(); });

  it("holds navigation until every edit is acknowledged", async () => {
    const request = Promise.withResolvers<unknown>();
    const navigate = vi.fn((event) => event.preventDefault());
    const save = vi.fn().mockReturnValue(request.promise);
    render(<SaveBoundary><Page save={save} /><a href="/resume" onClick={navigate}>Resume</a></SaveBoundary>);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "latest" } });
    fireEvent.click(screen.getByText("Resume"));
    await act(async () => {});
    expect(save).toHaveBeenCalledExactlyOnceWith("latest");
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => request.resolve({ ok: true }));
    expect(navigate).toHaveBeenCalledOnce();
  });

  it("keeps the page on a failed save, and allows a later successful retry", async () => {
    const save = vi.fn().mockResolvedValue({ ok: false, error: "Offline" });
    const navigate = vi.fn((event) => event.preventDefault());
    render(<SaveBoundary><Page save={save} /><a href="/resume" onClick={navigate}>Resume</a></SaveBoundary>);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "latest" } });
    await act(async () => fireEvent.click(screen.getByText("Resume")));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByText("Couldn't save")).toBeInTheDocument();
    expect(sessionStorage.length).toBe(1);
    save.mockResolvedValue({ ok: true });
    await act(async () => fireEvent.click(screen.getByText("Resume")));
    expect(navigate).toHaveBeenCalledOnce();
    expect(sessionStorage.length).toBe(0);
  });

  it("recovers an interrupted edit after remount and clears the copy only after acknowledgement", async () => {
    const request = Promise.withResolvers<unknown>();
    const before = render(<SaveBoundary><Page save={() => request.promise} /></SaveBoundary>);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "recovered" } });
    before.unmount();
    const saved = Promise.withResolvers<unknown>();
    const save = vi.fn().mockReturnValue(saved.promise);
    render(<SaveBoundary><Page save={save} /></SaveBoundary>);
    expect(screen.getByLabelText("Name")).toHaveValue("recovered");
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(sessionStorage.length).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(save).toHaveBeenCalledWith("recovered");
    await act(async () => saved.resolve({ ok: true }));
    expect(sessionStorage.length).toBe(0);
    expect(screen.getByText("Saved just now")).toBeInTheDocument();
    await act(async () => request.resolve({ ok: true }));
  });

  it.each([true, false])("requires review before resolving a conflict (use draft: %s)", async (useDraft) => {
    writeAutosaveDraft("test", { base: "older server value", value: "local draft" });
    const save = vi.fn().mockResolvedValue({ ok: true });
    render(<SaveBoundary><Page save={save} initial="newer server value" /></SaveBoundary>);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("local draft");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("newer server value");
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: useDraft ? "Use recovered changes" : "Keep saved version" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue(useDraft ? "local draft" : "newer server value");
    await act(async () => vi.advanceTimersByTimeAsync(500));
    if (useDraft) expect(save).toHaveBeenCalledExactlyOnceWith("local draft");
    else expect(save).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  it("does not write non-opted-in fields to browser storage", async () => {
    render(<SaveBoundary><Page save={vi.fn().mockResolvedValue({ ok: true })} recover={false} /></SaveBoundary>);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "private configuration" } });
    expect(sessionStorage.length).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(sessionStorage.length).toBe(0);
  });
});
