import { readArtifact } from "@/lib/career/library";
import { route } from "@/lib/route";
import { contentDisposition } from "@/lib/file-name";
export const GET = route(async (request) => {
  try {
    const { artifact, content } = await readArtifact(request.nextUrl.searchParams.get("id") ?? "");
    const textual = ["md", "txt", "json"].includes(artifact.kind);
    return new Response(new Uint8Array(content), { headers: {
      "content-type": textual ? "text/plain; charset=utf-8" : "application/octet-stream",
      "content-disposition": textual ? "inline" : contentDisposition(artifact.title),
      "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox",
    } });
  } catch { return Response.json({ error: "Source unavailable or changed since indexing. Review and re-index before opening it." }, { status: 409 }); }
});
