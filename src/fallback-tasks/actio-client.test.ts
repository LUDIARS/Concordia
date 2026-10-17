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

  const excubitor = {
    findService: vi.fn(async () => ({ code: "actio", name: "Actio", port: 4242, state: "running" })),
  } as unknown as Pick<ExcubitorClient, "findService">;
  const cursorOf = (url: string): string | null => new URL(url).searchParams.get("cursor");

  it("finds the task in an older Actio response without nextCursor", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ tasks: [{ id: "a1", pluginRef: "cc-task-1", description: "本文" }] }));
    const client = new ActioTaskClient(excubitor, fetchImpl as unknown as typeof fetch);

    expect(await client.findByConcordiaId("cc-task-1")).toEqual({ id: "a1", pluginRef: "cc-task-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("follows nextCursor of a newer Actio and stops at the page holding the match", async () => {
    const pages: Record<string, unknown> = {
      "": { tasks: [{ id: "a1", pluginRef: "other" }], nextCursor: "c-2" },
      "c-2": { tasks: [{ id: "a2", pluginRef: "cc-task-1" }], nextCursor: "c-3" },
    };
    const fetchImpl = vi.fn(async (url: string) => Response.json(pages[cursorOf(url) ?? ""]));
    const client = new ActioTaskClient(excubitor, fetchImpl as unknown as typeof fetch);

    expect(await client.findByConcordiaId("cc-task-1")).toMatchObject({ id: "a2" });
    expect(fetchImpl.mock.calls.map(([url]) => cursorOf(url))).toEqual([null, "c-2"]);
    expect(new URL(fetchImpl.mock.calls[0]![0]).searchParams.get("pluginId")).toBe("concordia");
  });

  it("returns null after the last page and reports a malformed list as unavailable", async () => {
    const last = vi.fn(async () => Response.json({ tasks: [], nextCursor: null }));
    expect(await new ActioTaskClient(excubitor, last as unknown as typeof fetch).findByConcordiaId("cc-task-1")).toBeNull();

    const malformed = vi.fn(async () => Response.json({ items: [] }));
    await expect(new ActioTaskClient(excubitor, malformed as unknown as typeof fetch).findByConcordiaId("cc-task-1"))
      .rejects.toMatchObject({ outcome: "unavailable" });
  });
});
