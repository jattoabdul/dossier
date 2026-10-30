"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { action, ActionError } from "@/lib/action";
import { prisma } from "@/lib/prisma";
import { ApplicationStatus } from "@/generated/prisma/enums";
export const reviewCareerIntake = action(z.object({ id: z.string(), company: z.string().trim().min(1).max(300), role: z.string().trim().min(1).max(300), status: z.enum(ApplicationStatus) }), async ({ id, company, role, status }) => {
  const result = await prisma.$transaction(async tx => {
    const intake = await tx.careerIntake.findUnique({ where: { id } });
    if (!intake) throw new ActionError("That source collection no longer exists.");
    if (intake.applicationId) return intake.applicationId;
    const application = await tx.application.create({ data: { title: `${role} · ${company}`, company, role, status, furthestStage: (["SENT", "SCREENING", "INTERVIEW", "OFFER", "ACCEPTED"] as string[]).includes(status) ? status as "SENT" | "SCREENING" | "INTERVIEW" | "OFFER" | "ACCEPTED" : null, notes: { create: { body: `Reviewed import from source collection: ${intake.collection}\n\nOriginal tracker wording:\n${intake.sourceStatus || "No explicit status recorded."}\n\nNext action in source:\n${intake.nextAction}\n\nStatus confirmed during import review. Original submission date is unknown.` } } } });
    // Compare-and-swap also prevents concurrent reviews from creating duplicate applications.
    const claimed = await tx.careerIntake.updateMany({ where: { id, applicationId: null }, data: { applicationId: application.id, reviewedAt: new Date(), company, role } });
    if (claimed.count !== 1) throw new ActionError("This collection was just reviewed. Reload the library.");
    return application.id;
  });
  revalidatePath("/library"); revalidatePath("/applications"); revalidatePath("/");
  return { applicationId: result };
});
