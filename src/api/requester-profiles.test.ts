import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { RequesterProfilesRepo } from "../db/requester-profiles-repo.js";
import { requesterProfilesRouter } from "./requester-profiles.js";

function makeApp() {
  const repo = new RequesterProfilesRepo(makeTestDb());
  return { repo, app: new Hono().route("/v1/requester-profiles", requesterProfilesRouter({ repo })) };
}

const put = (body: unknown): RequestInit => ({
  method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("requesterProfilesRouter", () => {
  it("upserts notes per company and lists them separately (CC-DLG-INV-01)", async () => {
    const { app } = makeApp();
    const created = await app.request("/v1/requester-profiles", put({
      platform: "discord", platform_user_id: "111", skill_level: "中級", activities: "Unity のゲーム開発",
    }));
    expect(created.status).toBe(200);
    await app.request("/v1/requester-profiles", put({ subsidiary_id: "glab", platform: "discord", platform_user_id: "111", notes: "外部" }));
    await app.request("/v1/requester-profiles", put({ platform: "discord", platform_user_id: "111", notes: "DDD を学習中" }));

    const head = await (await app.request("/v1/requester-profiles")).json() as { profiles: Array<Record<string, string>> };
    expect(head.profiles).toMatchObject([{ skill_level: "中級", activities: "Unity のゲーム開発", notes: "DDD を学習中" }]);
    const glab = await (await app.request("/v1/requester-profiles?subsidiary_id=glab")).json() as { profiles: unknown[] };
    expect(glab.profiles).toMatchObject([{ notes: "外部", skill_level: "" }]);
  });

  it("rejects malformed identities and deletes rows", async () => {
    const { app, repo } = makeApp();
    expect((await app.request("/v1/requester-profiles", put({ platform: "discord", platform_user_id: "a b" }))).status).toBe(400);
    const profile = repo.upsert({ subsidiary_id: null, platform: "discord", platform_user_id: "111" }, {});
    expect((await app.request(`/v1/requester-profiles/${profile.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/v1/requester-profiles/${profile.id}`, { method: "DELETE" })).status).toBe(404);
  });
});
