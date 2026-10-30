import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { createTestClient, resetDatabase } from "@/test/db";
import { buildExport } from "@/lib/data-export";
import { importExport, parseExport } from "@/lib/data-import";
vi.mock("@/lib/env",()=>({env:{DOSSIER_SECRET:"s".repeat(32)}}));
const db=createTestClient();beforeEach(()=>resetDatabase(db));afterAll(()=>db.$disconnect());
it("round trips source checksums, review state and import receipts without changing originals",async()=>{
 await db.careerArtifact.create({data:{id:"source",rootKey:"career",relativePath:"interviews/acme/resume.md",title:"Resume",collection:"acme",kind:"md",sha256:"a".repeat(64)}});
 await db.careerIntake.create({data:{id:"intake",collection:"acme",company:"Acme",sourceStatus:"Résumé shared; submission unconfirmed"}});
 await db.careerImport.create({data:{id:"receipt",report:{files:1}}});
 const data=parseExport(JSON.stringify(await buildExport(db)));if(!data.ok)throw new Error(data.error);
 await importExport(db,data.data);
 expect((await db.careerArtifact.findUniqueOrThrow({where:{id:"source"}})).sha256).toBe("a".repeat(64));
 expect((await db.careerIntake.findUniqueOrThrow({where:{id:"intake"}})).applicationId).toBeNull();
 expect(await db.careerImport.count()).toBe(1);expect(await db.application.count()).toBe(0);
});

it("preserves the local career links and draft history with 1.10 role context and older local exports", async () => {
 const application = await db.application.create({data:{company:"Harbor Systems",role:"Backend Engineer",title:"Backend Engineer"}});
 const document = await db.document.create({data:{applicationId:application.id,kind:"RESUME",units:[{id:"summary",label:"Summary",text:"Reviewed draft"}],versions:{create:{units:[{id:"summary",label:"Summary",text:"Earlier draft"}],cause:"WRITTEN"}}}});
 await db.experience.create({data:{id:"role",company:"Harbor Systems",descriptor:"Developer tooling team",bullets:"Built a reporting service."}});
 await db.careerArtifact.create({data:{id:"source",rootKey:"career",relativePath:"interviews/harbor/resume.md",title:"Resume",collection:"harbor",kind:"md",sha256:"b".repeat(64)}});
 await db.careerIntake.create({data:{id:"linked",collection:"harbor",company:"Harbor Systems",applicationId:application.id,sourceStatus:"Owner review pending"}});
 const exported = await buildExport(db);
 const parsed = parseExport(JSON.stringify(exported));
 if(!parsed.ok) throw new Error(parsed.error);
 await importExport(db,parsed.data);
 expect((await db.experience.findUniqueOrThrow({where:{id:"role"}})).descriptor).toBe("Developer tooling team");
 expect((await db.careerIntake.findUniqueOrThrow({where:{id:"linked"}})).applicationId).toBe(application.id);
 expect((await db.document.findUniqueOrThrow({where:{id:document.id},include:{versions:true}})).versions[0].units).toEqual([{id:"summary",label:"Summary",text:"Earlier draft"}]);
 // Our pre-upgrade local format also used version 6, without descriptor.
 const legacy = {...exported,profile:{...exported.profile,experience:exported.profile.experience.map(entry=>({...entry,descriptor:undefined}))}};
 const older = parseExport(JSON.stringify(legacy));
 if(!older.ok) throw new Error(older.error);
 await importExport(db,older.data);
 expect((await db.experience.findUniqueOrThrow({where:{id:"role"}})).descriptor).toBe("");
 expect((await db.careerIntake.findUniqueOrThrow({where:{id:"linked"}})).applicationId).toBe(application.id);
 expect((await db.careerArtifact.findUniqueOrThrow({where:{id:"source"}})).sha256).toBe("b".repeat(64));
});
