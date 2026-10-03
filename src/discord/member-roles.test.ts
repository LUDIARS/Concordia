import { describe, expect, it, vi } from "vitest";
import { listGuildRoles, memberRoleIds, type RoleClientLike, type RoleGuildLike } from "./member-roles.js";

function guild(
  id: string,
  name: string,
  roles: Array<{ id: string; name: string; managed?: boolean; position?: number }>,
  members: Record<string, string[]>,
): RoleGuildLike {
  return {
    id,
    name,
    roles: { cache: new Map(roles.map((role) => [role.id, role])) },
    members: {
      fetch: vi.fn(async (userId: string) => {
        const held = members[userId];
        if (!held) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
        return { roles: { cache: new Map(held.map((roleId) => [roleId, { id: roleId }])) } };
      }),
    },
  };
}

const client = (...guilds: RoleGuildLike[]): RoleClientLike => ({
  guilds: { cache: new Map(guilds.map((g) => [g.id, g])) },
});

describe("memberRoleIds", () => {
  it("在籍する全 guild のロールを集め、 @everyone と在籍しない guild は除く", async () => {
    const head = guild("900001", "本社", [], { "500001": ["900001", "10001"] });
    const sub = guild("900002", "子会社", [], { "500002": ["10002"] });
    expect(await memberRoleIds([client(head), client(sub, head)], "500001")).toEqual(["10001"]);
  });

  it("Bot が動いていなければ null、 Unknown Member 以外の失敗は投げる", async () => {
    expect(await memberRoleIds([], "500001")).toBeNull();
    const broken = guild("900001", "本社", [], {});
    (broken.members.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rate limited"));
    await expect(memberRoleIds([client(broken)], "500001")).rejects.toThrow("rate limited");
  });
});

describe("listGuildRoles", () => {
  it("guild ごとに名前つきのロールを上位から並べ、 @everyone と連携アプリのロールを除く", () => {
    const head = guild("900001", "本社", [
      { id: "900001", name: "@everyone", position: 0 },
      { id: "10001", name: "新入部員", position: 1 },
      { id: "10002", name: "メンター", position: 3 },
      { id: "10003", name: "Concordia", managed: true, position: 5 },
    ], {});
    expect(listGuildRoles([client(head)])).toEqual([{
      guild_id: "900001",
      guild_name: "本社",
      roles: [{ id: "10002", name: "メンター" }, { id: "10001", name: "新入部員" }],
    }]);
  });
});
