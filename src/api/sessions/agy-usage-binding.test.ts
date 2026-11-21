import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AGY_USAGE_BINDINGS } from "../../cost/agy-usage-binding.js";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import type { SessionRow } from "../../shared/types.js";
import { captureAgyUsageBinding } from "./agy-usage-binding.js";

const session = {
  id: "agy-fixture",
  provider: "antigravity-cli",
  status: "active",
  host: "fixture",
  started_at: 1_795_216_650,
  metadata: JSON.stringify({ lictor_port: 12345 }),
} as SessionRow;
const id = "11111111-1111-4111-8111-111111111111";
const dbPath = join(resolve("fixture"), id + ".db");

describe("captureAgyUsageBinding", () => {
  function fixture() {
    let metadata = { lictor_port: 12345 };
    const updateMetadata = vi.fn((_id: string, update: (value: typeof metadata) => typeof metadata) => {
      metadata = update(metadata);
    });
    const repo = {
      findSession: () => ({ ...session, metadata: JSON.stringify(metadata) }),
      updateMetadata,
    } as unknown as SessionsRepo;
    return { repo, updateMetadata };
  }

  function meta(sessionId: string): Response {
    return Response.json({
      session_id: sessionId, provider: "agy", hostname: session.host, cwd: "fixture",
      start_iso: new Date(session.started_at * 1000 - 250).toISOString(),
    });
  }

  it("publishes the path from the matching sidecar without consuming transcript frames", async () => {
    const { repo, updateMetadata } = fixture();
    const cancel = vi.fn();
    const request = vi.fn(async (_port: number, path: string) => path === "/v1/meta" ? meta(session.id)
      : new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ path: dbPath, available: true, total_lines: 1 })));
        },
        cancel,
      })));
    await captureAgyUsageBinding(repo, session, request, async (path) => path);
    expect(cancel).toHaveBeenCalledOnce();
    expect(JSON.parse(repo.findSession(session.id)?.metadata ?? "{}")).toEqual({
      lictor_port: 12345, [AGY_USAGE_BINDINGS]: [{ id, startedAtMs: session.started_at * 1000 - 250 }],
    });
    expect(updateMetadata).toHaveBeenCalledOnce();
  });

  it("declines a reused sidecar port before asking for a transcript path", async () => {
    const { repo, updateMetadata } = fixture();
    const request = vi.fn(async () => meta("other-session"));
    await captureAgyUsageBinding(repo, session, request);
    expect(request).toHaveBeenCalledOnce();
    expect(updateMetadata).not.toHaveBeenCalled();
  });
});
