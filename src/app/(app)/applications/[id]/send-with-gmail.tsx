"use client";

import { useRouter } from "next/navigation";
import { use, useEffect, useState, useTransition } from "react";
import { PendingSavesContext } from "@/components/save-boundary";
import { toastWithUndo } from "@/components/change-status";
import { SendReviewDialog } from "@/components/email/send-review";
import { toast } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { checkGmailSend, confirmGmailSend, inspectGmailSend, prepareGmailSend } from "@/lib/google/actions";
import type { SendReview } from "@/lib/google/send-intent";

export type GmailSender = { from: string } | { from: null; reason: "not-configured" | "not-connected" | "no-permission" | "disabled" };

export function SendWithGmail({ applicationId, sender, sentBefore }: {
  applicationId: string; sender: GmailSender; sentBefore: boolean;
}) {
  const router = useRouter();
  const saves = use(PendingSavesContext);
  const [open, setOpen] = useState(false);
  const [review, setReview] = useState<SendReview | null>(null);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    let active = true;
    void inspectGmailSend({ kind: "APPLICATION", targetId: applicationId }).then(result => {
      if (active && result.ok && result.data && ["SENDING", "UNKNOWN"].includes(result.data.state)) setReview(current => current ?? result.data);
    }).catch(() => {});
    return () => { active = false; };
  }, [applicationId]);
  const uncertain = review && ["SENDING", "UNKNOWN"].includes(review.state);
  if (sender.from === null && !uncertain) {
    if (sender.reason === "not-configured") return null;
    if (sender.reason === "disabled") return <p className="text-meta text-muted">Email sending is disabled. You can keep preparing your drafts.</p>;
    return <a href={sender.reason === "no-permission" ? "/api/google/connect?scopes=send" : "/settings?section=google"} className={buttonClassName("secondary", "md")}>
      {sender.reason === "no-permission" ? "Allow sending with Gmail" : "Connect Gmail to send"}
    </a>;
  }
  const prepare = () => startTransition(async () => {
    if (saves && !await saves.flush()) return toast("Save your changes before reviewing the email.");
    const result = await prepareGmailSend({ id: applicationId, resend: sentBefore }).catch(() => ({ ok: false as const, error: "Could not prepare the email. Try again." }));
    if (!result.ok) return toast(result.error);
    setReview(result.data);
    setOpen(true);
  });
  const finish = (check: boolean) => startTransition(async () => {
    if (!review) return;
    const result = await (check ? checkGmailSend : confirmGmailSend)({ intentId: review.id }).catch(() => ({ ok: false as const, error: "The result could not be confirmed. Check send status before trying again." }));
    if (!result.ok) {
      setReview({ ...review, state: "UNKNOWN" });
      return toast(result.error);
    }
    setReview(result.data.review);
    toastWithUndo(result.toast, result.data.eventId);
    if (result.data.review.state === "SENT") setOpen(false);
    router.refresh();
  });
  return <>
    <Button disabled={pending} onClick={() => uncertain ? setOpen(true) : prepare()}>{pending ? "Please wait…" : uncertain ? "Review send status" : sentBefore ? "Send again with Gmail" : "Send with Gmail"}</Button>
    <SendReviewDialog review={review} title="Send this application?" open={open} busy={pending} onOpenChange={setOpen} onConfirm={() => finish(false)} onCheck={() => finish(true)} />
  </>;
}
