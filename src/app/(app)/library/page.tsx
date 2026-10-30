import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { prisma } from "@/lib/prisma";
import { ReviewIntake } from "./review-intake";
export const metadata = { title: "Career library" };
export default async function LibraryPage({ searchParams }: PageProps<"/library">) {
  const params = await searchParams;
  const selected = typeof params.collection === "string" ? params.collection : null;
  const [groups, intakes, files, imports] = await Promise.all([
    prisma.careerArtifact.groupBy({ by: ["collection"], _count: true, orderBy: { collection: "asc" } }),
    prisma.careerIntake.findMany({ orderBy: { collection: "asc" } }),
    selected ? prisma.careerArtifact.findMany({ where: { collection: selected }, orderBy: { title: "asc" } }) : [],
    prisma.careerImport.findMany({ orderBy: { createdAt: "desc" }, take: 1 }),
  ]);
  const intake = intakes.find(item => item.collection === selected);
  return <>
    <PageHeader title="Career library" description="Your original preparation files, résumé tabs and application history. Review a collection before adding it to Applications." />
    <div className="px-10 pb-20 space-y-8">
      <p className="text-sm text-muted">{groups.reduce((sum, group) => sum + group._count, 0)} indexed sources · {intakes.filter(item => !item.applicationId).length} collections awaiting status review</p>
      {!selected && imports[0] && <section className="rounded-card bg-surface p-6 space-y-3"><h2 className="font-serif text-2xl">Initial import review</h2><p className="text-sm">Profile imported from the current résumé with conservative career rules. Please review your location, headline, Fera consulting dates and current project descriptions. Languages, references and other unverified personal fields remain blank.</p><Link className="underline" href="/profile">Review profile</Link><p className="text-sm text-muted">The index stores file references and checksums. Keep the original folders and Google documents, and back them up separately.</p></section>}
      <div className="flex flex-wrap gap-2">{groups.map(group => <Link className={`rounded-control px-3 py-2 text-sm ${group.collection === selected ? "bg-selected" : "bg-surface"}`} key={group.collection} href={`/library?collection=${encodeURIComponent(group.collection)}`}>{group.collection} ({group._count})</Link>)}</div>
      {selected && <section className="space-y-5"><h2 className="font-serif text-2xl">{selected}</h2>
        {intake && <div className="rounded-card bg-surface p-6 space-y-5">
          <h3 className="font-medium">Application review</h3>
          <details className="space-y-3"><summary className="cursor-pointer text-sm">Recorded history and next action</summary><pre className="whitespace-pre-wrap text-sm">{intake.sourceStatus || "Preparation files found. Application status has not been confirmed."}{intake.nextAction ? `\n\nNext action recorded: ${intake.nextAction}` : ""}</pre></details>
          {intake.applicationId ? <Link className="underline" href={`/applications/${intake.applicationId}`}>Open reviewed application</Link> : <><p className="text-sm text-muted">A folder may contain several roles or older drafts. Confirm the role and current status before creating an application. No submission date will be invented.</p><ReviewIntake id={intake.id} company={intake.company} role={intake.role} /></>}
        </div>}
        <ul className="space-y-3">{files.map(file => <li key={file.id} className="rounded-control bg-surface p-4"><a className="underline" target="_blank" rel="noopener noreferrer" href={file.url?.startsWith("https://docs.google.com/document/") ? file.url : `/api/career-artifact?id=${file.id}`}>{file.title}</a><p className="mt-1 text-xs text-muted">{file.kind} · {file.relativePath ?? "Google Docs tab"}{file.modifiedAt ? ` · source modified ${file.modifiedAt.toISOString().slice(0,10)}` : ""}</p></li>)}</ul>
      </section>}
    </div>
  </>;
}
