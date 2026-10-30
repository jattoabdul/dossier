CREATE TABLE "ConnectorSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "refreshId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revoked" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX "ConnectorSession_expiresAt_idx" ON "ConnectorSession"("expiresAt");
