/** @implements spec/feature/cc-task-fallback.md */
import { describe, expect, it, vi } from "vitest";
import type { ExcubitorClient } from "../excubitor/client.js";
import { ActioTaskClient } from "./actio-client.js";

describe("ActioTaskClient", () => {
  it("does not propagate an Actio response body into errors", async () => {
    const excubitor = {
      findService: vi.fn(async () => ({ code: "actio", name: "Actio", port: 4242, state: "running" })),
    } as unknown as Pick<ExcubitorClient, "findService">;
    const fetchImpl = vi.fn(async () => new Response("private upstream detail", { status: 500 }));
    const client = new ActioTaskClient(excubitor, fetchImpl as unknown as typeof fetch);

    const error = await client.findByConcordiaId("cc-task-1").catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      message: "Actio GET failed: 500",
      outcome: "unavailable",
    });
    expect((error as Error).message).not.toContain("private upstream detail");
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/api\/tasks/),
      expect.objectContaining({ redirect: "error" }),
    );
  });
});
