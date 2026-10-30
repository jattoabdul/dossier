ALTER TABLE "CareerIntake" ADD CONSTRAINT "CareerIntake_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;
