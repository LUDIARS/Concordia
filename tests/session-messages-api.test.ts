import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

function makeEnv() {
  const env = makeTestApp();
  env.repo.insertSession({
    id: "message-session",
    provider: "claude-code",
    repo_path: "/workspace/project",
    repo_origin: null,
    branch: "main",
    host: "host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: null,
  });
  return env;
}

describe("session messages API", () => {
  it("lists messages with validated cursor pagination", async () => {
    const env = makeEnv();
    const first = env.sessionMessages.upsert({
      session_id: "message-session",
      ts: 1,
      author_type: "user",
      author_label: "User",
      content: "first",
    }).row;
    env.sessionMessages.upsert({
      session_id: "message-session",
      ts: 2,
      author_type: "assistant",
      author_label: "Assistant",
      content: "second",
    });

    const response = await env.app.request(
      `/v1/sessions/message-session/messages?after=${first.id}&limit=1`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ messages: [{ content: "second" }] });

    const malformed = await env.app.request(
      "/v1/sessions/message-session/messages?before=abc",
    );
    expect(malformed.status).toBe(400);
    const ambiguous = await env.app.request(
      "/v1/sessions/message-session/messages?before=2&after=0",
    );
    expect(ambiguous.status).toBe(400);
  });

  it("keeps read cursors bounded by the session and monotonic", async () => {
    const env = makeEnv();
    const latest = env.sessionMessages.upsert({
      session_id: "message-session",
      ts: 1,
      author_type: "user",
      author_label: "User",
      content: "only",
    }).row;

    const tooLarge = await env.app.request("/v1/sessions/message-session/messages/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "client-a", last_read_id: Number.MAX_SAFE_INTEGER }),
    });
    expect(await tooLarge.json()).toEqual({ ok: true, last_read_id: latest.id });

    const stale = await env.app.request("/v1/sessions/message-session/messages/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "client-a", last_read_id: 0 }),
    });
    expect(await stale.json()).toEqual({ ok: true, last_read_id: latest.id });

    const unread = await env.app.request(
      "/v1/sessions/message-session/messages/unread?client_id=client-a",
    );
    expect(await unread.json()).toEqual({ last_read_id: latest.id, unread: 0 });
  });

  it("rejects invalid client identifiers", async () => {
    const env = makeEnv();
    const missing = await env.app.request(
      "/v1/sessions/message-session/messages/unread",
    );
    expect(missing.status).toBe(400);

    const tooLong = await env.app.request(
      `/v1/sessions/message-session/messages/unread?client_id=${"x".repeat(129)}`,
    );
    expect(tooLong.status).toBe(400);

    const nullCursor = await env.app.request("/v1/sessions/message-session/messages/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: "client-a", last_read_id: null }),
    });
    expect(nullCursor.status).toBe(400);
  });
});
