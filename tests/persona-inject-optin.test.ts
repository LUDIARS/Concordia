import { describe, expect, it } from "vitest";
import { eventBus, type ConcordiaEvent } from "../src/events.js";
import { makeTestApp } from "./helpers/test-app.js";

describe("persona injection opt-in", () => {
  it("defaults persona injection off and does not assign", async () => {
    const env = makeTestApp();
    let assignCalls = 0;
    const originalAssign = env.personas.assign.bind(env.personas);
    env.personas.assign = ((sessionId, rng) => {
      assignCalls += 1;
      return originalAssign(sessionId, rng);
    }) as typeof env.personas.assign;

    const emitted: ConcordiaEvent[] = [];
    const unsubscribe = eventBus.subscribe((ev) => emitted.push(ev));
    try {
      const response = await env.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "persona-off",
          provider: "codex-cli",
          repo_path: "/work/Concordia",
          branch: "main",
          host: "host",
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.persona).toBeNull();
      expect(body.persona_reused).toBe(false);
      expect(assignCalls).toBe(0);
      expect(env.personas.findActiveBySession("persona-off")).toBeNull();
      expect(emitted.some((ev) => ev.type === "persona.assigned")).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("assigns persona when enabled without enabling cc_workflow", async () => {
    const env = makeTestApp();
    env.adminState.setPersonaInjectEnabled(true);

    const emitted: ConcordiaEvent[] = [];
    const unsubscribe = eventBus.subscribe((ev) => emitted.push(ev));
    try {
      const response = await env.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: "persona-on",
          provider: "codex-cli",
          repo_path: "/work/Concordia",
          branch: "main",
          host: "host",
        }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as any;
      expect(body.persona).not.toBeNull();
      expect(body.context_packet.cc_workflow).toBeNull();
      expect(env.personas.findActiveBySession("persona-on")).not.toBeNull();
      expect(emitted.some((ev) => ev.type === "persona.assigned" && ev.session_id === "persona-on")).toBe(true);
    } finally {
      unsubscribe();
    }
  });
});
