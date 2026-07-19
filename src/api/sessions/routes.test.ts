import { describe, expect, it } from "vitest";
import { sessionsRouter } from "./index.js";

describe("sessionsRouter route table", () => {
  it("keeps the public sessions routes stable", () => {
    const app = sessionsRouter({} as never);
    const routes = ((app as any).routes as Array<{ method: string; path: string }>)
      .map((r) => `${r.method} ${r.path}`)
      .sort();

    expect(routes).toEqual([
      "DELETE /:id",
      "GET /",
      "GET /:id",
      "GET /:id/context",
      "GET /:id/discord-channels",
      "GET /:id/fs/grep",
      "GET /:id/fs/list",
      "GET /:id/fs/read",
      "GET /:id/goal",
      "GET /:id/goal-and-go",
      "GET /:id/skills",
      "GET /:id/pending-tasks",
      "GET /:id/tasks",
      "GET /:id/transcript",
      "PATCH /:id",
      "POST /",
      "POST /:id/abandon",
      "POST /:id/answer-question",
      "POST /:id/compact",
      "POST /:id/event",
      "POST /:id/fork",
      "POST /:id/goal",
      "POST /:id/goal-and-go",
      "POST /:id/heartbeat",
      "POST /:id/impl-unlock",
      "POST /:id/inject",
      "POST /:id/pending-question",
      "POST /:id/pending-question/:qid/resolve",
      "POST /:id/permission-request",
      "POST /:id/permission-response",
      "POST /:id/relictor",
      "POST /:id/request-stat",
      "POST /:id/request-title",
      "POST /:id/resume",
      "POST /:id/session-end-done",
      "POST /:id/skill",
      "POST /:id/title",
      "POST /:id/title-suggestion",
      "POST /:id/transcript-frame",
    ].sort());
  });
});
