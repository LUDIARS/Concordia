import { describe, expect, it, vi } from "vitest";
import { consultGuildMemberIds } from "./consult-guild-members.js";

function guild(members: Record<string, true>, failWith?: unknown) {
  return {
    members: {
      fetch: vi.fn(async (id: string) => {
        if (failWith) throw failWith;
        if (members[id]) return { id };
        throw Object.assign(new Error("Unknown Member"), { code: 10007 });
      }),
    },
  } as never;
}

describe("consultGuildMemberIds", () => {
  it("その guild に在籍する人だけを重複なく返す", async () => {
    expect(await consultGuildMemberIds(guild({ "900": true }), ["900", "901", "900"])).toEqual(["900"]);
  });

  it("在籍の確認自体に失敗したら投げ返す (確かめずに閲覧者を決めない)", async () => {
    await expect(consultGuildMemberIds(guild({}, Object.assign(new Error("rate limited"), { code: 0 })), ["900"]))
      .rejects.toThrow("rate limited");
  });
});
