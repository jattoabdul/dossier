CREATE TABLE "EmailSendIntent" (
 "id" TEXT NOT NULL, "scope" TEXT, "kind" TEXT NOT NULL, "targetId" TEXT NOT NULL,
 "applicationId" TEXT, "accountEmail" TEXT NOT NULL, "fingerprint" TEXT NOT NULL,
 "messageId" TEXT NOT NULL, "payload" JSONB NOT NULL, "state" TEXT NOT NULL DEFAULT 'PREPARED',
 "gmailId" TEXT, "threadId" TEXT, "eventId" TEXT, "attemptedAt" TIMESTAMP(3), "sentAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "EmailSendIntent_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "EmailSendIntent_state_check" CHECK ("state" IN ('PREPARED','SENDING','UNKNOWN','SENT','CANCELLED')),
 CONSTRAINT "EmailSendIntent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmailSendIntent_scope_key" ON "EmailSendIntent"("scope");
CREATE UNIQUE INDEX "EmailSendIntent_messageId_key" ON "EmailSendIntent"("messageId");
CREATE INDEX "EmailSendIntent_kind_targetId_idx" ON "EmailSendIntent"("kind", "targetId");
