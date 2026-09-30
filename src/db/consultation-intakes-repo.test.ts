import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { ConsultationIntakesRepo } from "./consultation-intakes-repo.js";

const base = {
  subsidiary_id: null,
  department_id: "dept_qa",
  use_case_id: "uc_qa",
  platform: "discord" as const,
  platform_user_id: "111",
  source: "forum" as const,
  topic: "DDD って何が良いの",
  skill_level: "初級",
  role_title: "エンジニア",
  purpose: "",
};

describe("ConsultationIntakesRepo", () => {
  it("records the four intake items for the reception channel", () => {
    const repo = new ConsultationIntakesRepo(makeTestDb());
    const row = repo.record({ ...base, channel_id: "thread-1" }, 5);
    expect(row).toMatchObject({ ...base, channel_id: "thread-1", created_at: 5 });
    expect(row.id).toMatch(/^ci_/);
  });

  it("returns the newest intake of a channel", () => {
    const repo = new ConsultationIntakesRepo(makeTestDb());
    repo.record({ ...base, channel_id: "thread-1", topic: "old" }, 1);
    repo.record({ ...base, channel_id: "thread-1", topic: "new" }, 2);
    repo.record({ ...base, channel_id: "thread-2", topic: "other" }, 3);
    expect(repo.latestForChannel("thread-1")?.topic).toBe("new");
    expect(repo.latestForChannel("missing")).toBeNull();
  });
});
