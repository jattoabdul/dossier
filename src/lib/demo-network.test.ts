import { expect, it, vi } from "vitest";
import { demoFetch } from "./demo-network";

it("blocks external destinations before fetch and refuses redirects from the mock", async () => {
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
  const fetch = demoFetch(upstream);
  for (const url of ["https://api.openai.com/v1", "http://127.0.0.1:4000", "http://user:secret@127.0.0.1:3999", "http://127.0.0.1.evil.invalid:3999"]) {
    await expect(fetch(url)).rejects.toThrow("external network");
  }
  expect(upstream).not.toHaveBeenCalled();
  await fetch("http://127.0.0.1:3999/v1/models");
  expect(upstream).toHaveBeenCalledWith("http://127.0.0.1:3999/v1/models", { redirect: "error" });
});
