"use server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { action, ActionError } from "@/lib/action";
import { configureCodex } from "@/lib/connector/codex";
import { env } from "@/lib/env";
export const setCodexConnector = action(z.object({ on: z.boolean() }), async ({ on }) => {
  if (!env.DOSSIER_CODEX_BRIDGE_FILE || env.DOSSIER_DEMO_MODE === "on") throw new ActionError("The Codex connector is available in your local personal instance.");
  await configureCodex(on);
  revalidatePath("/settings");
  revalidatePath("/new");
  return { on };
});
