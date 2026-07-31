import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeTestApp, type TestAppEnv } from "./helpers/test-app.js";
import { capabilityAllowed } from "../src/staff/roles.js";

// 社員名簿 (役職権限登録リスト) の API と権限判定の回帰テスト。
// spec/feature/staff-roster.md。

describe("staff roster API", () => {
  let env: TestAppEnv;

  beforeEach(() => { env = makeTestApp(); });
  afterEach(() => { env.db.close(); });

  it("records LLM access as ヒラ社員 with the server profile name", () => {
    env.staff.touch({
      platform: "discord",
      platformUserId: "u1",
      displayName: "global-name",
      profileName: "サーバー表示名",
    });

    const member = env.staff.find("discord", "u1");
    expect(member?.role).toBe("staff");
    expect(member?.profile_name).toBe("サーバー表示名");
    expect(member?.display_name).toBe("global-name");
  });

  it("never downgrades a role or clears a known name on re-access", () => {
    env.staff.upsertManual({
      platform: "discord",
      platformUserId: "u1",
      profileName: "初回名",
      role: "executive",
    });
    env.staff.touch({ platform: "discord", platformUserId: "u1", profileName: "" });

    const member = env.staff.find("discord", "u1");
    expect(member?.role).toBe("executive");
    expect(member?.profile_name).toBe("初回名");
  });

  it("GET /v1/staff returns members, counts and the capability legend", async () => {
    env.staff.touch({ platform: "discord", platformUserId: "plain" });
    env.staff.upsertManual({ platform: "discord", platformUserId: "boss", role: "executive" });

    const response = await env.app.request("/v1/staff");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      members: Array<{ platform_user_id: string; role: string }>;
      counts: { discord: { staff: number; executive: number } };
      has_executive: boolean;
      capabilities: Array<{ capability: string; min_role: string }>;
    };
    expect(body.members).toHaveLength(2);
    expect(body.counts.discord.staff).toBe(1);
    expect(body.counts.discord.executive).toBe(1);
    expect(body.has_executive).toBe(true);
    expect(body.capabilities.find((c) => c.capability === "kill_switch")?.min_role).toBe("executive");
  });

  it("PATCH /v1/staff promotes an existing member", async () => {
    env.staff.touch({ platform: "discord", platformUserId: "u1" });

    const response = await env.app.request("/v1/staff/discord/u1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "manager", note: "スプリント担当" }),
    });
    expect(response.status).toBe(200);
    const member = env.staff.find("discord", "u1")!;
    expect(member.role).toBe("manager");
    expect(member.note).toBe("スプリント担当");
    expect(capabilityAllowed(member.role, "session_spawn")).toBe(true);
    expect(capabilityAllowed(member.role, "kill_switch")).toBe(false);
  });

  it("PATCH /v1/staff rejects unknown roles and missing members", async () => {
    env.staff.touch({ platform: "discord", platformUserId: "u1" });

    const badRole = await env.app.request("/v1/staff/discord/u1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "ceo" }),
    });
    expect(badRole.status).toBe(400);

    const missing = await env.app.request("/v1/staff/discord/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "manager" }),
    });
    expect(missing.status).toBe(404);
  });

  it("POST /v1/staff registers a member who has not spoken yet", async () => {
    const response = await env.app.request("/v1/staff", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "discord",
        platform_user_id: "future",
        role: "manager",
      }),
    });
    expect(response.status).toBe(201);
    expect(env.staff.roleOf("discord", "future")).toBe("manager");
  });

  it("DELETE /v1/staff removes the member so they fall back to ヒラ社員", async () => {
    env.staff.upsertManual({ platform: "discord", platformUserId: "u1", role: "manager" });

    const response = await env.app.request("/v1/staff/discord/u1", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(env.staff.roleOf("discord", "u1")).toBeNull();
    expect(capabilityAllowed(null, "session_spawn")).toBe(false);
    expect(capabilityAllowed(null, "converse")).toBe(true);
  });

  it("counts capability holders per platform", () => {
    env.staff.touch({ platform: "discord", platformUserId: "plain" });
    env.staff.upsertManual({ platform: "discord", platformUserId: "mgr", role: "manager" });
    env.staff.upsertManual({ platform: "discord", platformUserId: "exec", role: "executive" });
    env.staff.upsertManual({ platform: "slack", platformUserId: "s-mgr", role: "manager" });

    expect(env.staff.countByCapability("discord", "session_spawn")).toBe(2);
    expect(env.staff.countByCapability("discord", "kill_switch")).toBe(1);
    expect(env.staff.countByCapability("slack", "kill_switch")).toBe(0);
  });
});
