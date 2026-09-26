import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ChatRepo } from "../db/chat-repo.js";
import { eventBus, type ConcordiaEvent } from "../events.js";
import { chatRouter } from "./chat.js";

describe("chatRouter", () => {
  it("accepts Genius questions through the internal chat API", async () => {
    const app = chatRouter({
      chat: new ChatRepo(makeTestDb()),
      resolveWorkspaceRoots: () => [],
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        channel: "genius",
        text: "Need one more fact",
        session_id: "session-1",
        author_label: "Genius",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      message: { channel: "genius", text: "Need one more fact" },
    });
  });
});

describe("system administrator mentions", () => {
  const request = (overrides = {}) => ({ method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel: "system", text: "Risk notice", session_id: "test-session",
      author_label: "Revisor", mention_admin: true, ...overrides }) });
  it("emits only the configured administrator and acknowledges mention resolution", async () => {
    const db = makeTestDb();
    const events: ConcordiaEvent[] = [];
    const unsubscribe = eventBus.subscribe((event) => events.push(event));
    try {
      const app = chatRouter({ chat: new ChatRepo(db), resolveWorkspaceRoots: () => [],
        resolveMentionAdmin: () => "123456789012345678" });
      const response = await app.request("/", request({ metadata: { mention_user_ids: { discord: ["999999999999999999"] } } }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ mention_admin_resolved: true });
      expect(events.find((event) => event.type === "chat.posted")).toMatchObject({
        channel: "system", mention_user_ids: { discord: ["123456789012345678"], slack: [] } });
    } finally { unsubscribe(); db.close(); }
  });
  it.each([null, "invalid"])("refuses an unconfigured administrator before saving: %s", async (admin) => {
    const db = makeTestDb();
    try {
      const chat = new ChatRepo(db);
      const app = chatRouter({ chat, resolveWorkspaceRoots: () => [], resolveMentionAdmin: () => admin });
      expect((await app.request("/", request())).status).toBe(400);
      expect(chat.list({ channel: "system", limit: 10 })).toHaveLength(0);
    } finally { db.close(); }
  });
  it("does not allow administrator pings on other channels or reply endpoints", async () => {
    const db = makeTestDb();
    try {
      const app = chatRouter({ chat: new ChatRepo(db), resolveWorkspaceRoots: () => [],
        resolveMentionAdmin: () => "123456789012345678" });
      expect((await app.request("/", request({ channel: "報告" }))).status).toBe(400);
      const original = await (await app.request("/", request({ mention_admin: false }))).json();
      expect((await app.request("/" + original.message.id + "/reply", request())).status).toBe(400);
    } finally { db.close(); }
  });
});
