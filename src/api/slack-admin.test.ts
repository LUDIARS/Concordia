import { describe, it, expect, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeSlackConfigRepo } from "../db/slack-config-repo.js";
import { SecretBox } from "../shared/secret-box.js";
import { slackAdminRouter, type SlackBotAdmin } from "./slack-admin.js";

function makeApp() {
  const ok = async () => ({ ok: true, status: "started" });
  const admin: SlackBotAdmin = {
    start: vi.fn(ok),
    stop: vi.fn(ok),
    restart: vi.fn(ok),
    status: () => ({ running: true, embedded_enabled: true, last_status: "started", last_error: null }),
  };
  const app = slackAdminRouter({
    config: makeSlackConfigRepo(makeTestDb()),
    secretBox: new SecretBox(randomBytes(32)),
    admin,
  });
  return { app, admin };
}

const put = (body: unknown) => ({
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("slack admin member-map", () => {
  it("保存した対応表を返し、 bot は再接続しない", async () => {
    const { app, admin } = makeApp();
    const entries = [{ discord_user_id: "111111111111", slack_user_id: "UAAAA1111" }];
    const saved = await app.request("/member-map", put({ entries }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ entries });
    expect(await (await app.request("/member-map")).json()).toEqual({ entries });
    expect(admin.restart).not.toHaveBeenCalled();
  });

  it("形式違反は 400", async () => {
    const { app } = makeApp();
    const bad = await app.request("/member-map", put({ entries: [{ discord_user_id: "x", slack_user_id: "UAAAA1111" }] }));
    expect(bad.status).toBe(400);
    const unknownKey = await app.request("/member-map", put({ entries: [], extra: 1 }));
    expect(unknownKey.status).toBe(400);
  });
});

describe("slack admin always-invite", () => {
  it("保存した常時招待メンバーを返し、 bot は再接続しない", async () => {
    const { app, admin } = makeApp();
    const saved = await app.request("/always-invite", put({ user_ids: [" U9B7AE3SQ ", "U9B7AE3SQ"] }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ user_ids: ["U9B7AE3SQ"] });
    expect(await (await app.request("/always-invite")).json()).toEqual({ user_ids: ["U9B7AE3SQ"] });
    expect(admin.restart).not.toHaveBeenCalled();
  });

  it("形式違反は 400、 空配列で解除する", async () => {
    const { app } = makeApp();
    expect((await app.request("/always-invite", put({ user_ids: ["not-a-slack-id"] }))).status).toBe(400);
    await app.request("/always-invite", put({ user_ids: ["U9B7AE3SQ"] }));
    expect(await (await app.request("/always-invite", put({ user_ids: [] }))).json()).toEqual({ user_ids: [] });
    expect(await (await app.request("/always-invite")).json()).toEqual({ user_ids: [] });
  });
});
