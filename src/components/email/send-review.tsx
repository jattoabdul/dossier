"use client";

import { AlertDialog } from "radix-ui";
import { Button, buttonClassName } from "@/components/ui/button";
import type { SendReview } from "@/lib/google/send-intent";

/** The exact saved message. Unknown delivery never offers a second send. */
export function SendReviewDialog({ review, title, open, busy, onOpenChange, onConfirm, onCheck, onResend }: {
  review: SendReview | null; title: string; open: boolean; busy: boolean;
  onOpenChange: (open: boolean) => void; onConfirm: () => void; onCheck: () => void; onResend?: () => void;
}) {
  if (!review) return null;
  const uncertain = review.state === "SENDING" || review.state === "UNKNOWN";
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-dialog bg-card p-6 shadow-menu">
          <AlertDialog.Title className="font-serif text-[22px] leading-tight">{title}</AlertDialog.Title>
          <AlertDialog.Description className="text-sm text-muted">
            {uncertain ? "This message may already have been sent. Check its status before taking further action. Checking will not send another message."
              : review.state === "SENT" ? "This message was sent. Dossier has recorded it."
              : review.state === "CANCELLED" ? "This review has been replaced. Close it and review the message again."
              : "Check the recipient, message and attachments. Sending cannot be undone."}
          </AlertDialog.Description>
          <div className="min-h-0 space-y-4 overflow-auto">
            <dl className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-1.5 text-sm">
              <dt>From</dt><dd className="[overflow-wrap:anywhere]">{review.from}</dd>
              <dt>To</dt><dd className="[overflow-wrap:anywhere]">{review.to}</dd>
              <dt>Subject</dt><dd className="[overflow-wrap:anywhere]">{review.subject}</dd>
              <dt>Attached</dt><dd>{review.attachments.length ? review.attachments.map((name, i) => <span key={i}>{i > 0 && ", "}<a className="underline" href={`/api/email-send/attachment?id=${encodeURIComponent(review.id)}&index=${i}`} target="_blank" rel="noreferrer">{name}</a></span>) : "Nothing"}</dd>
            </dl>
            <div className="rounded-control bg-canvas px-4 py-3 text-control leading-[1.6] whitespace-pre-wrap [overflow-wrap:anywhere]">{review.body}</div>
          </div>
          <div className="mt-2 flex justify-end gap-2">
            <AlertDialog.Cancel disabled={busy} className={buttonClassName("secondary", "sm")}>{review.state === "PREPARED" ? "Cancel" : "Close"}</AlertDialog.Cancel>
            {review.state === "PREPARED" && <Button size="sm" disabled={busy} onClick={onConfirm}>{busy ? "Sending…" : "Send now"}</Button>}
            {review.state === "SENT" && onResend && <Button size="sm" disabled={busy} onClick={onResend}>Review another reply</Button>}
            {uncertain && <Button size="sm" disabled={busy} onClick={onCheck}>{busy ? "Checking…" : "Check send status"}</Button>}
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
