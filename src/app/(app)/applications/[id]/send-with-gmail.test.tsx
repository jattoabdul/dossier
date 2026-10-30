import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toastWithUndo } from "@/components/change-status";
import { toast } from "@/components/toast";
import { checkGmailSend, inspectGmailSend, prepareGmailSend, confirmGmailSend } from "@/lib/google/actions";

import { PendingSavesContext } from "@/components/save-boundary";
import { createPendingSaves } from "@/lib/pending-saves";
import { SendWithGmail } from "./send-with-gmail";

const review = vi.hoisted(() => ({ id: "12345678-1234-4234-8234-123456789012", state: "PREPARED", from: "jane@gmail.com", to: "careers@northwind.example", subject: "Application", body: "Dear team, here is my application.", attachments: ["Jane – Resume.pdf"] }));
vi.mock("@/lib/google/actions", () => ({
  inspectGmailSend: vi.fn(async () => ({ ok: true, data: null })),
  prepareGmailSend: vi.fn(async () => ({ ok: true, data: review })),
  confirmGmailSend: vi.fn(async () => ({ ok: true, data: { review: { ...review, state: "SENT" }, eventId: "ev1" }, toast: "Sent." })),
  checkGmailSend: vi.fn(async () => ({ ok: true, data: { review: { ...review, state: "SENT" }, eventId: "ev1" }, toast: "Sent." })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ toast: vi.fn() }));
vi.mock("@/components/change-status", () => ({ toastWithUndo: vi.fn() }));

const props = { applicationId: "nw", to: "careers@northwind.example", subject: "Application", attachments: ["Jane – Resume.pdf"], sentBefore: false };

beforeEach(() => vi.clearAllMocks());

describe("SendWithGmail (E15-2)", () => {
  it("says what goes where, and sends once confirmed", async () => {
    const user = userEvent.setup();
    render(<SendWithGmail {...props} sender={{ from: "jane@gmail.com" }} />);
    await user.click(screen.getByRole("button", { name: "Send with Gmail" }));
    const dialog = screen.getByRole("alertdialog", { name: "Send this application?" });
    expect(dialog).toHaveTextContent("jane@gmail.com");
    expect(dialog).toHaveTextContent("careers@northwind.example");
    expect(dialog).toHaveTextContent("Jane – Resume.pdf");
    await user.click(await screen.findByRole("button", { name: "Send now" }));
    expect(prepareGmailSend).toHaveBeenCalledWith({ id: "nw", resend: false });
    expect(confirmGmailSend).toHaveBeenCalledWith({ intentId: review.id });
    expect(toastWithUndo).toHaveBeenCalledWith("Sent.", "ev1");
  });

  it("asks for a recipient first", async () => {
    const user = userEvent.setup();
    vi.mocked(prepareGmailSend).mockResolvedValueOnce({ ok: false, error: "Add who it's to first: the posting doesn't give an address." });
    render(<SendWithGmail {...props} sender={{ from: "jane@gmail.com" }} />);
    await user.click(screen.getByRole("button", { name: "Send with Gmail" }));
    expect(toast).toHaveBeenCalledWith("Add who it's to first: the posting doesn't give an address.");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("points to connecting, or to the missing permission, and hides without a Google client", () => {
    const { rerender, container } = render(<SendWithGmail {...props} sender={{ from: null, reason: "not-connected" }} />);
    expect(screen.getByRole("link", { name: "Connect Gmail to send" })).toHaveAttribute("href", "/settings?section=google");
    rerender(<SendWithGmail {...props} sender={{ from: null, reason: "no-permission" }} />);
    expect(screen.getByRole("link", { name: "Allow sending with Gmail" })).toHaveAttribute("href", "/api/google/connect?scopes=send");
    rerender(<SendWithGmail {...props} sender={{ from: null, reason: "not-configured" }} />);
    expect(container).toBeEmptyDOMElement();
  });
});


it("shows a closed sending guard and keeps drafts available", () => {
  render(<SendWithGmail {...props} sender={{ from: null, reason: "disabled" }} />);
  expect(screen.getByText(/Email sending is disabled/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Send with Gmail" })).not.toBeInTheDocument();
  expect(prepareGmailSend).not.toHaveBeenCalled();
});

it("restores an uncertain attempt after reload, including when sending is disabled", async () => {
  vi.mocked(inspectGmailSend).mockResolvedValueOnce({ ok: true, data: { ...review, state: "UNKNOWN" } });
  const user = userEvent.setup();
  render(<SendWithGmail {...props} sender={{ from: null, reason: "disabled" }} />);
  await user.click(await screen.findByRole("button", { name: "Review send status" }));
  expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
  await user.click(await screen.findByRole("button", { name: "Check send status" }));
  expect(checkGmailSend).toHaveBeenCalledWith({ intentId: review.id });
  expect(confirmGmailSend).not.toHaveBeenCalled();
  expect(prepareGmailSend).not.toHaveBeenCalled();
});

it.each(["returned", "lost"])("offers a read-only status check when the send response is %s", async response => {
  if (response === "returned") vi.mocked(confirmGmailSend).mockResolvedValueOnce({ ok: false, error: "The send outcome is uncertain." });
  else vi.mocked(confirmGmailSend).mockRejectedValueOnce(new Error("connection closed"));
  const user = userEvent.setup();
  render(<SendWithGmail {...props} sender={{ from: "jane@gmail.com" }} />);
  await user.click(screen.getByRole("button", { name: "Send with Gmail" }));
  await user.click(await screen.findByRole("button", { name: "Send now" }));
  expect(await screen.findByRole("button", { name: "Check send status" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Send now" })).not.toBeInTheDocument();
  expect(confirmGmailSend).toHaveBeenCalledTimes(1);
});

it("waits for pending saves before preparing the immutable review", async () => {
  const saves = { ...createPendingSaves(), recover: vi.fn() };
  let dirty = true;
  let finish!: (value: boolean) => void;
  saves.register({ isDirty: () => dirty, flush: () => new Promise(resolve => { finish = resolve; }) });
  const user = userEvent.setup();
  render(<PendingSavesContext value={saves}><SendWithGmail {...props} sender={{ from: "jane@gmail.com" }} /></PendingSavesContext>);
  await user.click(screen.getByRole("button", { name: "Send with Gmail" }));
  expect(prepareGmailSend).not.toHaveBeenCalled();
  await act(async () => { dirty = false; finish(true); });
  await waitFor(() => expect(prepareGmailSend).toHaveBeenCalledTimes(1));
});

it("does not prepare a stale review when saving fails", async () => {
  const saves = { ...createPendingSaves(), recover: vi.fn() };
  saves.register({ isDirty: () => true, flush: async () => false });
  const user = userEvent.setup();
  render(<PendingSavesContext value={saves}><SendWithGmail {...props} sender={{ from: "jane@gmail.com" }} /></PendingSavesContext>);
  await user.click(screen.getByRole("button", { name: "Send with Gmail" }));
  expect(prepareGmailSend).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith("Save your changes before reviewing the email.");
});
