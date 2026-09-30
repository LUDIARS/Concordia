import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PrivateConsultationsRepo } from "./private-consultations-repo.js";

const base = {
  subsidiary_id: null,
  department_id: "dept_qa",
  requester_user_id: "111",
  status: "pending_approval" as const,
  intake_json: JSON.stringify({ topic: "t", skill_level: "初級", role_title: "学生", purpose: "" }),
};

describe("PrivateConsultationsRepo", () => {
  it("tracks a consultation through channel, approval, session and closing", () => {
    const repo = new PrivateConsultationsRepo(makeTestDb());
    const created = repo.create(base, 1);
    expect(created).toMatchObject({ status: "pending_approval", channel_id: null, session_id: null });
    repo.setChannel(created.id, "chan-1", 2);
    expect(repo.findByChannel("chan-1")?.id).toBe(created.id);

    expect(repo.markOpen(created.id, "222", 3)).toBe(true);
    expect(repo.markOpen(created.id, "333", 4)).toBe(false);
    expect(repo.find(created.id)).toMatchObject({ status: "open", approved_by: "222", approved_at: 3 });

    repo.setSession(created.id, "sess-1", 5);
    expect(repo.findBySession("sess-1")?.id).toBe(created.id);

    expect(repo.markClosed(created.id, 6)).toBe(true);
    expect(repo.markClosed(created.id, 7)).toBe(false);
    expect(repo.find(created.id)).toMatchObject({ status: "closed", closed_at: 6 });
  });

  it("keeps members with their reason and restores a removed member as re-added", () => {
    const repo = new PrivateConsultationsRepo(makeTestDb());
    const { id } = repo.create(base, 1);
    repo.addMember({ consultation_id: id, platform_user_id: "111", reason: "requester", added_by: "111" }, 1);
    repo.addMember({ consultation_id: id, platform_user_id: "222", reason: "approver", added_by: "system" }, 1);
    repo.addMember({ consultation_id: id, platform_user_id: "333", reason: "invited", added_by: "111" }, 2);
    // 既存の閲覧者を加え直しても理由は変えない。
    repo.addMember({ consultation_id: id, platform_user_id: "222", reason: "invited", added_by: "111" }, 3);
    expect(repo.members(id).map((m) => [m.platform_user_id, m.reason])).toEqual([
      ["111", "requester"], ["222", "approver"], ["333", "invited"],
    ]);

    expect(repo.removeMember(id, "333", 4)).toBe(true);
    expect(repo.removeMember(id, "333", 5)).toBe(false);
    expect(repo.members(id).map((m) => m.platform_user_id)).toEqual(["111", "222"]);

    repo.addMember({ consultation_id: id, platform_user_id: "333", reason: "invited", added_by: "222" }, 6);
    expect(repo.members(id).find((m) => m.platform_user_id === "333")).toMatchObject({ added_by: "222", added_at: 6 });
  });
});
