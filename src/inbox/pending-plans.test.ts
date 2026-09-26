/** @implements spec/feature/approval-inbox.md — CC-INBOX-PLAN-01 */
import { afterEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DirectorRepo } from "../director/repo.js";
import { DirectorService } from "../director/service.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { pendingPlans } from "./pending-plans.js";
import { inboxItems } from "./read-model.js";
import { buildDigestText } from "./digest.js";
import { buildSessionReturnNotice, shouldNotifyOnReturn } from "./session-return-notice.js";

const dbs: ReturnType<typeof makeTestDb>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = makeTestDb(); dbs.push(db);
  const sessions = new SessionsRepo(db);
  for (const id of ["s1", "s2"]) sessions.insertSession({
    id, provider: "codex-cli", repo_path: "repo", repo_origin: null, branch: "main", host: "h",
    started_at: 1, last_seen_at: 1, transcript_path: null, metadata: null,
  });
  const repo = new DirectorRepo(db);
  let now = 1000;
  const service = new DirectorService({ repo, genius: { query: async () => [] }, scoreMin: 0.8, now: () => now++ });
  const create = (sessionId: string) => {
    const c = service.createCase({ title: "Check @everyone", goal: "design", project: "Cc", session_id: sessionId,
      steps: [{ kind: "plan", title: "Plan" }] });
    return { case_id: c.case.id, step_id: c.steps[0].id };
  };
  const submit = (ids: ReturnType<typeof create>) => service.submitPlan({ ...ids, markdown: "# plan\n## 受け入れ条件\n- works" });
  return { db, repo, service, create, submit };
}

describe("Design plan unanswered notices", () => {
  it("includes plan-only return notices and digest without also counting a blocked step", () => {
    const f = fixture(); const ids = f.create("s1"); f.submit(ids);
    const plans = pendingPlans(f.db, "s1");
    expect(plans).toHaveLength(1);
    expect(shouldNotifyOnReturn({ sessionActive: true, unansweredCount: plans.length, lastNotifiedAt: null, nowMs: 2000 })).toBe(true);
    const notice = buildSessionReturnNotice({ questions: [], plans, guildId: null, channelId: null });
    expect(notice).toContain("Design plan v1");
    expect(notice).toContain("1 件");
    expect(notice).not.toContain("@everyone");
    const items = inboxItems(f.db);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("design-plan-approval");
    expect(buildDigestText(items, 2000)).toContain("Design plan 承認待ち 1");
  });

  it("uses the latest version and removes approve, revise and discard answers", () => {
    for (const action of ["approve", "revise", "discard"] as const) {
      const f = fixture(); const ids = f.create("s1"); f.submit(ids); f.submit(ids);
      expect(pendingPlans(f.db).map(x => x.version)).toEqual([2]);
      expect(() => f.service.decidePlan({ ...ids, action, version: 1, instruction: "change" })).toThrow("superseded");
      f.service.decidePlan({ ...ids, action, version: 2, instruction: "change" });
      expect(pendingPlans(f.db)).toEqual([]);
      expect(inboxItems(f.db)).toEqual([]);
      expect(f.repo.listDecisions(ids.case_id).find(x => x.plan_version === 2)?.human_answered_at).not.toBeNull();
      if (action === "revise") {
        expect(() => f.service.decidePlan({ ...ids, action: "approve", version: 2 })).toThrow("already answered");
        f.submit(ids);
        expect(pendingPlans(f.db).map(x => x.version)).toEqual([3]);
      }
    }
  });

  it("scopes session returns and excludes ended sessions", () => {
    const f = fixture(); f.submit(f.create("s1")); f.submit(f.create("s2"));
    expect(pendingPlans(f.db, "s1").map(x => x.sessionId)).toEqual(["s1"]);
    f.db.prepare("UPDATE sessions SET status = 'ended' WHERE id = 's1'").run();
    expect(pendingPlans(f.db, "s1")).toEqual([]);
    expect(pendingPlans(f.db).map(x => x.sessionId)).toEqual(["s2"]);
  });

  it("counts mixed notices within the same item limit and orders by actual timestamp", () => {
    const f = fixture(); f.submit(f.create("s1"));
    const text = buildSessionReturnNotice({ plans: pendingPlans(f.db, "s1"), guildId: null, channelId: null, maxListed: 1,
      questions: [{ id: 1, question: "later question", discordMessageId: null, ts: 5 }] });
    expect(text).toContain("2 件");
    expect(text).toContain("Design plan v1");
    expect(text).toContain("ほか 1 件");
    expect(text).not.toContain("later question");
  });
});
