// A two-phase local import: read-only index, reviewed hash, then an empty-database transaction.
import { readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { z } from "zod";
import { indexCareerRoot, digest, readSourceFile } from "../src/lib/career/files";
const local = path.resolve(".local-personal");
const config = JSON.parse(await readFile(path.join(local, "env.json"), "utf8"));
const dest = path.join(local, "imports");
await mkdir(dest, { recursive: true, mode: 0o700 });
const save = async (name: string, data: string) => { const file = path.join(dest,name); await writeFile(file,data,{mode:0o600}); await chmod(file,0o600); };
const planFile = path.join(dest,"index-plan.json");
// Source-specific names and mappings stay with the private import inputs.
const layoutSchema = z.object({
  trackerPath: z.string().default("job-search-tracker.md"),
  tabMappings: z.record(z.string(), z.string()).default({}),
  workTimeZone: z.string().refine(value => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
    catch { return false; }
  }, "Use a valid time zone").default("UTC"),
});
const layoutText = await readFile(path.join(dest,"source-layout.json"),"utf8").catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return "{}";
  throw error;
});
const layout = layoutSchema.parse(JSON.parse(layoutText));
if (process.argv[2] === "index") {
  if (!config.DOSSIER_CAREER_ROOT) throw new Error("Configure the career root first.");
  const indexed = await indexCareerRoot(config.DOSSIER_CAREER_ROOT);
  const profile = JSON.parse(await readFile(path.join(dest,"profile-reviewed.json"),"utf8"));
  const topology = JSON.parse(await readFile(path.join(dest,"resume-tabs.json"),"utf8"));
  const tracker = indexed.files.find(file => file.relativePath === layout.trackerPath);
  const trackerText = tracker ? (await readSourceFile(config.DOSSIER_CAREER_ROOT, tracker.relativePath, tracker.sha256)).toString("utf8") : "";
  const blocks = trackerText.split(/^### /m).slice(1);
  const collections = [...new Set(indexed.files.filter(file => file.relativePath.startsWith("interviews/") && file.relativePath.split("/").length >= 3).map(file => file.collection))];
  const intakes = collections.map(collection => {
    const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
    const block = blocks.find(text => normalize(text.split("\n")[0]).startsWith(normalize(collection))) ?? blocks.find(text => !/^(Already|Canada-Friendly|US |Notes)/.test(text) && text.includes(`interviews/${collection}/`));
    const lines = block?.split("\n") ?? [];
    const role = lines.find(line => line.startsWith("- Role:"))?.slice(8).trim() ?? "";
    // Preserve the original section verbatim; it can include older statuses and their dates.
    return { id: digest(`intake:${collection}`).slice(0,32), collection, company: collection.split("-").map(word => word[0].toUpperCase()+word.slice(1)).join(" "), role, sourceStatus: block ? `Tracker excerpt (historical, review before confirming):\n\n${block.trim()}` : "", nextAction: lines.find(line => line.startsWith("- Next action:"))?.slice(14).trim() ?? "" };
  });
  const tabMappings = layout.tabMappings;
  const google = topology.tabs.map((tab: { title:string;tabId:string }) => {
    const mapped = Object.entries(tabMappings).find(([prefix]) => tab.title.startsWith(prefix))?.[1];
    const collection = mapped ?? collections.find(name => tab.title.toLowerCase().replace(/[^a-z0-9]/g,"").startsWith(name.replace(/[^a-z0-9]/g,""))) ?? "career-guidance";
    return { id: digest(`google:${topology.documentId}:${tab.tabId}`).slice(0,32), title:tab.title, collection, kind:"google-doc",url:`https://docs.google.com/document/d/${topology.documentId}/edit?tab=${tab.tabId}` };
  });
  const snapshots = [];
  for (const name of ["resume-current.json","resume-base.json","resume-tabs.json"]) {
    const content=await readSourceFile(dest,name);
    snapshots.push({id:digest(`imports:${name}`).slice(0,32),rootKey:"imports",relativePath:name,title:name,collection:"career-guidance",kind:"json",sha256:digest(content),bytes:content.length});
  }
  const plan={version:1, indexedAt:new Date().toISOString(), files:[...indexed.files,...google,...snapshots], skipped:indexed.skipped,intakes,profile};
  const content=JSON.stringify(plan,null,2);
  await save("index-plan.json",content);
  await save("IMPORT-REVIEW.md",`# Reviewed personal import\n\nPlan SHA-256: ${digest(content)}\n\n${indexed.files.length} local files, ${google.length} Google Doc tab links, ${snapshots.length} read-only snapshots, ${intakes.length} preparation collections.\n\nNo original files will move or change. No Google Doc writes. No application status or submission date is inferred.\n\n## Profile review\n\n${profile.review.map((item:string)=>`- ${item}`).join("\n")}\n\n## Collections\n\n${intakes.map(item=>`- ${item.collection}: ${item.role || "role to review"}; ${item.sourceStatus ? "tracker excerpt preserved" : "status unknown"}`).join("\n")}\n\n## Skipped sources\n\n${indexed.skipped.map(item=>`- ${item}`).join("\n")}\n`);
  console.log(JSON.stringify({planHash:digest(content),localFiles:indexed.files.length,googleTabs:google.length,collections:intakes.length,skipped:indexed.skipped.length}));
} else if (process.argv[2] === "apply") {
  const content = await readFile(planFile,"utf8"), hash=digest(content);
  if (process.argv[3] !== hash) throw new Error("Review IMPORT-REVIEW.md and supply the exact plan hash.");
  const plan=JSON.parse(content);
  const url=new URL(config.DATABASE_URL);
  if(url.hostname!=="127.0.0.1" || url.pathname!=="/dossier_personal") throw new Error("Import is restricted to the local personal database.");
  for(const file of plan.files) if(file.relativePath) await readSourceFile(file.rootKey==="career"?config.DOSSIER_CAREER_ROOT:dest,file.relativePath,file.sha256);
  const db=new PrismaClient({adapter:new PrismaPg({connectionString:config.DATABASE_URL})});
  try {
    if(await db.careerImport.findUnique({where:{id:hash}})) { console.log("This exact plan is already imported. Nothing changed."); process.exitCode=0; }
    else {
      await db.$transaction(async tx=>{
        if(await tx.profileField.count() || await tx.application.count() || await tx.careerArtifact.count() || await tx.experience.count() || await tx.skill.count() || await tx.project.count() || await tx.education.count()) throw new Error("The target contains personal data. Refusing to overwrite it.");
        await tx.profileField.createMany({data:Object.entries(plan.profile.fields).map(([key,value])=>({key,value:String(value)}))});
        await tx.skill.createMany({data:plan.profile.skills.map((name:string,sort:number)=>({name,sort}))});
        await tx.experience.createMany({data:plan.profile.experience});
        await tx.project.createMany({data:plan.profile.projects});
        await tx.education.createMany({data:plan.profile.education});
        await tx.fact.createMany({data:plan.profile.facts.map((text:string,sort:number)=>({text,sort}))});
        await tx.careerArtifact.createMany({data:plan.files});
        await tx.careerIntake.createMany({data:plan.intakes});
        await tx.careerImport.create({data:{id:hash,report:{source:plan.profile.source,review:plan.profile.review,files:plan.files.length,collections:plan.intakes.length,originalsUnchanged:true}}});
        for(const [key,value] of Object.entries({updateCheck:"false",gmailRead:"false",calendarAvailability:"false",calendarEvents:"false",agentEnabled:"false",agentAutoDraft:"false",experienceOrder:"manual",projectOrder:"manual",workTimeZone:layout.workTimeZone})) await tx.setting.upsert({where:{key},create:{key,value},update:{value}});
      },{timeout:30_000});
      await save("IMPORT-RECEIPT.json",JSON.stringify({planHash:hash,importedAt:new Date().toISOString(),artifacts:plan.files.length,collections:plan.intakes.length,applicationsCreated:0,sourceHashesVerified:true},null,2));
      console.log("Reviewed import committed. Original sources verified unchanged. Statuses await review in Career library.");
    }
  } finally {await db.$disconnect();}
} else throw new Error("Usage: tsx scripts/career-import.mts index|apply <reviewed-plan-hash>");
