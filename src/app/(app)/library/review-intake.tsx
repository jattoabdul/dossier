"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toastResult } from "@/components/toast";
import { reviewCareerIntake } from "./actions";
import { statusInfo } from "@/lib/status";
import { ApplicationStatus } from "@/generated/prisma/enums";
export function ReviewIntake({ id, company, role }: { id: string; company: string; role: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return <form className="flex flex-wrap items-end gap-3" onSubmit={async event => {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true);
    const result = toastResult(await reviewCareerIntake({ id, company: String(data.get("company")), role: String(data.get("role")), status: String(data.get("status")) as ApplicationStatus }));
    if (result.ok) router.push(`/applications/${result.data.applicationId}`);
    setBusy(false);
  }}>
    <label className="text-sm">Company<input className="block rounded-control bg-input p-2" name="company" defaultValue={company} required maxLength={300} /></label>
    <label className="text-sm">Role<input className="block rounded-control bg-input p-2" name="role" defaultValue={role} required maxLength={300} /></label>
    <label className="text-sm">Confirmed status<select className="block rounded-control bg-input p-2" name="status" defaultValue="" required><option value="" disabled>Choose a status</option>{Object.values(ApplicationStatus).map(value => <option key={value} value={value}>{statusInfo(value).label}</option>)}</select></label>
    <Button disabled={busy} type="submit">Confirm and add application</Button>
  </form>;
}
