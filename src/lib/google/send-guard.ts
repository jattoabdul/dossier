import "server-only";
import type { Prisma } from "@/generated/prisma/client";

export class PendingEmailSends extends Error {
  constructor() { super("Check the status of pending email sends before replacing or deleting your data."); }
}

export async function assertNoPendingEmailSends(db: Pick<Prisma.TransactionClient, "emailSendIntent">) {
  if (await db.emailSendIntent.count({ where: { state: { in: ["SENDING", "UNKNOWN"] } } })) throw new PendingEmailSends();
}

/** Also blocks a concurrent claim until the replacement transaction commits. */
export async function guardEmailSendHistory(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`LOCK TABLE "EmailSendIntent" IN SHARE ROW EXCLUSIVE MODE`;
  await assertNoPendingEmailSends(tx);
}
