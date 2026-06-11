import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { makeParticipantsRepo, canonicalizeName, type ParticipantsRepo } from "./participants-repo.js";

describe("participants repo", () => {
  let repo: ParticipantsRepo;
  beforeEach(() => {
    const db = makeTestDb();
    repo = makeParticipantsRepo(db);
  });

  it("upsert → findByPlatformUser", () => {
    const row = repo.upsert({ platform: "discord", platform_user_id: "U1", display_name: "太郎" });
    expect(row.canonical_name).toBe("太郎");
    expect(repo.findByPlatformUser("discord", "U1")?.display_name).toBe("太郎");
    expect(repo.findByPlatformUser("slack", "U1")).toBeNull();
  });

  it("upsert は (platform, user) 一意 — 表示名を更新", () => {
    repo.upsert({ platform: "discord", platform_user_id: "U1", display_name: "太郎" });
    const updated = repo.upsert({ platform: "discord", platform_user_id: "U1", display_name: "Taro" });
    expect(updated.display_name).toBe("Taro");
    expect(repo.findByPlatformUser("discord", "U1")?.display_name).toBe("Taro");
  });

  it("別PF同名は同一 canonical で解決される (listByCanonical)", () => {
    repo.upsert({ platform: "discord", platform_user_id: "D1", display_name: "Taro" });
    repo.upsert({ platform: "slack", platform_user_id: "S1", display_name: "taro" }); // 大小違い
    const same = repo.listByCanonical("TARO");
    expect(same.map((r) => r.platform).sort()).toEqual(["discord", "slack"]);
  });

  it("canonicalizeName は前後空白除去 + 小文字化", () => {
    expect(canonicalizeName("  Taro ")).toBe("taro");
  });
});
