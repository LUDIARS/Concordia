import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

function buildTestApp() {
  return makeTestApp();
}

describe("sessions API — pending-question / discord-channels", () => {
  let env: ReturnType<typeof buildTestApp>;
  beforeEach(() => { env = buildTestApp(); });

  describe("pending-question / answer-question", () => {
    it("POST pending-question stores row + emits question.posted", async () => {
      await env.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "pq", provider: "claude-code", repo_path: "/x", host: "h" }),
      });
      const { eventBus } = await import("../src/events.js");
      const hits: any[] = [];
      const unsub = eventBus.subscribe((ev) => { if (ev.type === "question.posted") hits.push(ev); });
      try {
        const r = await env.app.request("/v1/sessions/pq/pending-question", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: "Pick one", options: ["A", "B"] }),
        });
        expect(r.status).toBe(200);
        const j = await r.json() as any;
        expect(j.ok).toBe(true);
        expect(j.question_id).toBeGreaterThan(0);
        expect(hits).toHaveLength(1);
      } finally {
        unsub();
      }
    });

    it("POST answer-question answers once and second try is 409", async () => {
      await env.app.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "aq", provider: "claude-code", repo_path: "/x", host: "h" }),
      });
      const qRes = await env.app.request("/v1/sessions/aq/pending-question", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "Pick one", options: ["A", "B"] }),
      });
      const q = await qRes.json() as any;
      const r1 = await env.app.request("/v1/sessions/aq/answer-question", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question_id: q.question_id, answer_index: 1 }),
      });
      expect(r1.status).toBe(200);
      const j1 = await r1.json() as any;
      expect(j1.answer_text).toBe("B");

      const r2 = await env.app.request("/v1/sessions/aq/answer-question", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question_id: q.question_id, answer_index: 0 }),
      });
      expect(r2.status).toBe(409);
    });
  });

  describe("GET /v1/sessions/:id/discord-channels", () => {
    it("returns null session channel when none created, meta channels from config", async () => {
      const env2 = makeTestApp();
      // discord_config に meta channel を仕込む
      env2.discordConfig.set("chitchat_channel_id", "111");
      env2.discordConfig.set("consultation_channel_id", "222");
      const localApp = env2.app;
      await localApp.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ds", provider: "claude-code", repo_path: "/x", host: "h" }),
      });
      const res = await localApp.request("/v1/sessions/ds/discord-channels");
      expect(res.status).toBe(200);
      const j = await res.json() as any;
      expect(j.ok).toBe(true);
      expect(j.session_channel_id).toBe(null); // channel 未作成
      expect(j.meta_channels.chitchat).toBe("111");
      expect(j.meta_channels.consultation).toBe("222");
      expect(j.meta_channels.system).toBe(null);
    });

    it("returns the session channel id once a row exists", async () => {
      const env2 = makeTestApp();
      const channels = env2.discordChannels;
      const localApp = env2.app;
      await localApp.request("/v1/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: "ds2", provider: "claude-code", repo_path: "/x", host: "h" }),
      });
      channels.upsert({ session_id: "ds2", channel_id: "999", status: "active" });
      const res = await localApp.request("/v1/sessions/ds2/discord-channels");
      const j = await res.json() as any;
      expect(j.session_channel_id).toBe("999");
      expect(j.session_channel_status).toBe("active");
    });

    it("404 for unknown session", async () => {
      const res = await env.app.request("/v1/sessions/nope/discord-channels");
      expect(res.status).toBe(404);
    });
  });
});
