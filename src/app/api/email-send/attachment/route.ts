import { z } from "zod";
import { sendAttachment } from "@/lib/google/send-intent";
import { pdfDownload } from "@/lib/pdf/downloads";
import { route } from "@/lib/route";

export const GET = route(async request => {
  const input = z.object({ id: z.string().uuid(), index: z.coerce.number().int().min(0).max(1) }).safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!input.success) return new Response("Not found", { status: 404 });
  const file = await sendAttachment(input.data.id, input.data.index);
  return file ? pdfDownload(file.pdf, file.fileName) : new Response("Not found", { status: 404 });
});
