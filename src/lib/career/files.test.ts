import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digest, indexCareerRoot, readSourceFile } from "./files";
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir,{recursive:true,force:true}); });
async function fixture() { const dir=await mkdtemp(path.join(os.tmpdir(),"dossier-index-"));dirs.push(dir);await mkdir(path.join(dir,"interviews/acme"),{recursive:true});await writeFile(path.join(dir,"interviews/acme/resume.md"),"Original résumé");return dir; }
describe("read-only career sources",()=>{
 it("indexes original files without changing them and keeps root notes out of company collections",async()=>{
  const dir=await fixture();await writeFile(path.join(dir,"interviews/notes.md"),"History");
  const result=await indexCareerRoot(dir);
  expect(result.files.map(file=>file.collection)).toEqual(["acme","career-guidance"]);
  expect((await readSourceFile(dir,"interviews/acme/resume.md",digest("Original résumé"))).toString()).toBe("Original résumé");
 });
 it("refuses traversal, symlinks, and sources changed after indexing",async()=>{
  const dir=await fixture();await symlink(path.join(dir,"interviews/acme"),path.join(dir,"alias"));
  await expect(readSourceFile(dir,"../secret")).rejects.toThrow("Invalid source path");
  await expect(readSourceFile(dir,"alias/resume.md")).rejects.toThrow("Symbolic links");
  await expect(readSourceFile(dir,"interviews/acme/resume.md",digest("Old"))).rejects.toThrow("changed since");
  expect((await indexCareerRoot(dir)).skipped).toContain("alias");
 });
});
