import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { registerQaRoutes } from "./qa.js";
import type { SessionsApiDeps } from "./deps.js";

it.each(["pending-question", "permission-request", "answer-question", "escalate-question"])(
  "rejects unsafe %s before persisting or relaying the request", async route => {
    const check = vi.fn(async () => ({ blocked: true, reason: "confidential_data" as const, penaltyEligible: true }));
    const app = new Hono();
    registerQaRoutes(app, { repo: { findSession: () => ({ id: "s" }) }, consultationSafety: { check } } as unknown as SessionsApiDeps);
    const response = await app.request(`/s/${route}`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "private-content", tool_input: { secret: "private-content" } }) });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("private-content");
    expect(check).toHaveBeenCalledWith(expect.objectContaining({ phase: route === "answer-question" ? "prompt" : "output" }));
  });
