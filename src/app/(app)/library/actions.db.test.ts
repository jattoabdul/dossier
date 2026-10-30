import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createTestClient, resetDatabase } from "@/test/db";
const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
const session = vi.hoisted(() => ({ on: true }));
vi.mock("@/lib/prisma", async () => { const { createTestClient } = await import("@/test/db"); db.client = createTestClient(); return { prisma: db.client }; });
vi.mock("@/lib/auth/session", () => ({ getSession: async () => session.on ? {} : null }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import { reviewCareerIntake } from "./actions";
beforeEach(async () => { await resetDatabase(db.client!); session.on = true; await db.client!.careerIntake.create({ data: { id: "source", collection: "acme", company: "Acme", sourceStatus: "Resume shared; submission unconfirmed" } }); });
afterAll(() => db.client!.$disconnect());
it("requires authentication and an explicit status", async () => {
 session.on = false;
 expect((await reviewCareerIntake({ id: "source", company: "Acme", role: "Engineer", status: "DRAFT" })).ok).toBe(false);
 expect(await db.client!.application.count()).toBe(0);
});
it("imports the reviewed role once, keeps the evidence and leaves an unknown submission date empty", async () => {
 const input = { id: "source", company: "Acme", role: "Backend Engineer", status: "SCREENING" as const };
 const first = await reviewCareerIntake(input); expect(first.ok).toBe(true);
 await reviewCareerIntake(input);
 expect(await db.client!.application.count()).toBe(1);
 const application = await db.client!.application.findFirstOrThrow({ include: { notes: true } });
 expect(application.sentAt).toBeNull(); expect(application.furthestStage).toBe("SCREENING");
 expect(application.notes[0].body).toContain("submission unconfirmed");
 await db.client!.application.delete({ where: { id: application.id } });
 expect((await db.client!.careerIntake.findUniqueOrThrow({ where: { id: "source" } })).applicationId).toBeNull();
});
