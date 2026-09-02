import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ChatRepo } from "../db/chat-repo.js";
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
