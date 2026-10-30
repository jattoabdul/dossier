import "server-only";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { readSourceFile } from "./files";
export async function readArtifact(id: string) {
  const artifact = await prisma.careerArtifact.findUnique({ where: { id } });
  if (!artifact || !artifact.relativePath || !artifact.sha256) throw new Error("No local source for this item.");
  const root = artifact.rootKey === "career" ? env.DOSSIER_CAREER_ROOT : artifact.rootKey === "imports" ? env.DOSSIER_IMPORTS_ROOT : undefined;
  if (!root) throw new Error("This source library is not configured on this machine.");
  return { artifact, content: await readSourceFile(root, artifact.relativePath, artifact.sha256) };
}
