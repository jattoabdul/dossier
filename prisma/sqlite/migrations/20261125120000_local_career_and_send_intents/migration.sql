CREATE TABLE "CareerArtifact" (
 "id" TEXT NOT NULL PRIMARY KEY, "rootKey" TEXT, "relativePath" TEXT, "url" TEXT,
 "title" TEXT NOT NULL, "collection" TEXT NOT NULL, "kind" TEXT NOT NULL,
 "sha256" TEXT, "bytes" INTEGER, "modifiedAt" DATETIME, "indexedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CareerArtifact_collection_idx" ON "CareerArtifact"("collection");
CREATE TABLE "CareerIntake" (
 "id" TEXT NOT NULL PRIMARY KEY, "collection" TEXT NOT NULL, "company" TEXT NOT NULL,
 "role" TEXT NOT NULL DEFAULT '', "sourceStatus" TEXT NOT NULL DEFAULT '', "nextAction" TEXT NOT NULL DEFAULT '',
 "applicationId" TEXT REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE, "reviewedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CareerIntake_collection_idx" ON "CareerIntake"("collection");
CREATE TABLE "CareerImport" ("id" TEXT NOT NULL PRIMARY KEY, "report" JSONB NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "EmailSendIntent" (
 "id" TEXT NOT NULL, "scope" TEXT, "kind" TEXT NOT NULL, "targetId" TEXT NOT NULL,
 "applicationId" TEXT, "accountEmail" TEXT NOT NULL, "fingerprint" TEXT NOT NULL,
 "messageId" TEXT NOT NULL, "payload" JSONB NOT NULL, "state" TEXT NOT NULL DEFAULT 'PREPARED',
 "gmailId" TEXT, "threadId" TEXT, "eventId" TEXT, "attemptedAt" DATETIME, "sentAt" DATETIME,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL,
 CONSTRAINT "EmailSendIntent_pkey" PRIMARY KEY ("id"),
 CONSTRAINT "EmailSendIntent_state_check" CHECK ("state" IN ('PREPARED','SENDING','UNKNOWN','SENT','CANCELLED')),
 CONSTRAINT "EmailSendIntent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EmailSendIntent_scope_key" ON "EmailSendIntent"("scope");
CREATE UNIQUE INDEX "EmailSendIntent_messageId_key" ON "EmailSendIntent"("messageId");
CREATE INDEX "EmailSendIntent_kind_targetId_idx" ON "EmailSendIntent"("kind", "targetId");

CREATE UNIQUE INDEX "CareerIntake_applicationId_key" ON "CareerIntake"("applicationId");
CREATE TABLE "ConnectorSession" ("id" TEXT NOT NULL PRIMARY KEY, "refreshId" TEXT NOT NULL, "expiresAt" DATETIME NOT NULL, "revoked" BOOLEAN NOT NULL DEFAULT false);
CREATE INDEX "ConnectorSession_expiresAt_idx" ON "ConnectorSession"("expiresAt");
