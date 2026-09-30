import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { RequesterProfilesRepo } from "./requester-profiles-repo.js";

const identity = { subsidiary_id: null, platform: "discord" as const, platform_user_id: "111" };

describe("RequesterProfilesRepo", () => {
  it("creates an empty row for a new requester and keeps human edits on later posts", () => {
    const repo = new RequesterProfilesRepo(makeTestDb());
    expect(repo.ensure(identity, "neco", 1)).toMatchObject({ display_name: "neco", skill_level: "", created_at: 1 });
    repo.upsert(identity, { display_name: "ねこ", skill_level: "上級" }, 2);
    expect(repo.ensure(identity, "neco-renamed", 3)).toMatchObject({ display_name: "ねこ", skill_level: "上級", updated_at: 2 });
  });

  it("fills an empty display name without touching other fields", () => {
    const repo = new RequesterProfilesRepo(makeTestDb());
    repo.upsert(identity, { notes: "メモ" }, 1);
    expect(repo.ensure(identity, "neco", 2)).toMatchObject({ display_name: "neco", notes: "メモ" });
  });

  it("keeps one row per company, platform and user", () => {
    const repo = new RequesterProfilesRepo(makeTestDb());
    repo.ensure(identity, "a");
    repo.ensure(identity, "a");
    repo.ensure({ ...identity, subsidiary_id: "glab" }, "a");
    expect(repo.list(null)).toHaveLength(1);
    expect(repo.list("glab")).toHaveLength(1);
  });
});
