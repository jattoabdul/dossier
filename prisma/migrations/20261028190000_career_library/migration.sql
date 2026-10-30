CREATE TABLE "CareerArtifact" (
 "id" TEXT PRIMARY KEY, "rootKey" TEXT, "relativePath" TEXT, "url" TEXT,
 "title" TEXT NOT NULL, "collection" TEXT NOT NULL, "kind" TEXT NOT NULL,
 "sha256" TEXT, "bytes" INTEGER, "modifiedAt" TIMESTAMP(3), "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CareerArtifact_collection_idx" ON "CareerArtifact"("collection");
CREATE TABLE "CareerIntake" (
 "id" TEXT PRIMARY KEY, "collection" TEXT NOT NULL, "company" TEXT NOT NULL,
 "role" TEXT NOT NULL DEFAULT '', "sourceStatus" TEXT NOT NULL DEFAULT '', "nextAction" TEXT NOT NULL DEFAULT '',
 "applicationId" TEXT UNIQUE, "reviewedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CareerIntake_collection_idx" ON "CareerIntake"("collection");
CREATE TABLE "CareerImport" ("id" TEXT PRIMARY KEY, "report" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
