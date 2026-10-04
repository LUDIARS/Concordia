import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { registerRelayRoutes } from "./relay.js";
import type { SessionsApiDeps } from "./deps.js";

it.each(["text", "summary", "thinking", "tool-result", "image"])(
  "replaces blocked %s before storage and projection with a visible refusal", async kind => {
    const check = vi.fn(async () => ({ blocked: true, reason: "confidential_data" as const, penaltyEligible: true }));
    const insert = vi.fn(() => true);
    const project = vi.fn();
    const app = new Hono();
    registerRelayRoutes(app, { repo: { findSession: () => ({ id: "s", status: "ended" }) },
      consultationSafety: { check }, transcriptLogs: { insert },
      channelDirectory: { findSessionChannel: () => null }, projectSessionEvent: project } as unknown as SessionsApiDeps);
    const response = await app.request("/s/transcript-frame", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: 1, kind, payload: { role: "assistant", text: "private-content", data: "private-content" } }) });
    expect(response.status).toBe(200);
    expect(check).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ kind: "text",
      payload: expect.objectContaining({ text: expect.stringContaining("表示できません") }) }));
    expect(JSON.stringify(insert.mock.calls)).not.toContain("private-content");
    expect(JSON.stringify(project.mock.calls)).not.toContain("private-content");
  });
