import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAutosave } from "@/hooks/use-autosave";
import { SavedIndicator } from "./saved-indicator";
import { TrackSaveContext, useSaveTracker } from "./save-tracker";

vi.mock("@/components/toast", () => ({ toast: vi.fn() }));

function Field({ value, save }: { value: string; save: (value: string) => Promise<unknown> }) {
  useAutosave(value, save);
  return null;
}

function Page({ value, save }: { value: string; save: (value: string) => Promise<unknown> }) {
  const saves = useSaveTracker();
  return <TrackSaveContext value={saves.track}>
    <SavedIndicator status={saves.status} savedAt={saves.savedAt} />
    <Field value={value} save={save} />
  </TrackSaveContext>;
}

describe("page save status", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("includes the debounce and a newer queued edit in the page's saving state", async () => {
    const first = Promise.withResolvers<unknown>();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({ ok: true });
    const { rerender } = render(<Page value="original" save={save} />);
    rerender(<Page value="first" save={save} />);
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(500));
    rerender(<Page value="latest" save={save} />);
    await act(async () => first.resolve({ ok: true }));
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(screen.queryByText("Saved just now")).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(500));
    expect(save).toHaveBeenLastCalledWith("latest");
    expect(screen.getByText("Saved just now")).toBeInTheDocument();
  });

  it("does not let an unrelated successful request erase an unsaved failure", async () => {
    const { result } = renderHook(() => useSaveTracker());
    const failed = Promise.withResolvers<unknown>();
    const succeeded = Promise.withResolvers<unknown>();
    act(() => { void result.current.track(failed.promise); void result.current.track(succeeded.promise); });
    await act(async () => failed.resolve({ ok: false, error: "Offline" }));
    await act(async () => succeeded.resolve({ ok: true }));
    expect(result.current.status).toBe("error");
  });
});
