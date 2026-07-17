import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import { SubsidiaryBudgetTracker, localDayRange } from "./budget.js";

let db: ReturnType<typeof makeTestDb>;
let repo: SessionsRepo;

// 2026-06-26 12:00 local 固定。
const NOW = new Date(2026, 5, 26, 12, 0, 0).getTime();

function addSession(id: string, startedAt: number, subsidiaryId: string | null): void {
  repo.insertSession({
    id,
    provider: "claude-code",
    repo_path: `E:/Document/Ars/Pictor`,
    repo_origin: null,
    branch: null,
    host: "h",
    started_at: startedAt,
    last_seen_at: startedAt,
    transcript_path: null,
    metadata: subsidiaryId ? JSON.stringify({ subsidiary_id: subsidiaryId }) : null,
  });
}

// セッション 1 本 = 固定の usage を返すスタブ (id 末尾の数字 × 1000 トークン)。
async function readUsageStub(s: SessionRow): Promise<{ total: number } | null> {
  const n = Number(s.id.replace(/\D/g, "")) || 0;
  return n > 0 ? { total: n * 1000 } : null;
}

beforeEach(() => {
  db = makeTestDb();
  repo = new SessionsRepo(db);
});

describe("SubsidiaryBudgetTracker", () => {
  it("当日の subsidiary_id 一致セッションのトークンだけ合算する", async () => {
    addSession("s10", NOW, "sub-a"); // 10k → sub-a
    addSession("s20", NOW, "sub-a"); // 20k → sub-a
    addSession("s30", NOW, "sub-b"); // 30k → sub-b (別子会社)
    addSession("s40", NOW, null); //    本社 (タグ無し)
    const tracker = new SubsidiaryBudgetTracker({ sessionsRepo: repo, readUsage: readUsageStub, now: () => NOW });
    expect(await tracker.todayTokens("sub-a", NOW)).toBe(30_000);
    expect(await tracker.todayTokens("sub-b", NOW)).toBe(30_000);
    expect(await tracker.todayTokens("sub-none", NOW)).toBe(0);
  });

  it("前日に始まったセッションは当日消費に含めない", async () => {
    const [todayStart] = localDayRange(NOW);
    addSession("s10", todayStart - 1000, "sub-a"); // 昨日
    addSession("s20", NOW, "sub-a"); //              今日
    const tracker = new SubsidiaryBudgetTracker({ sessionsRepo: repo, readUsage: readUsageStub, now: () => NOW });
    expect(await tracker.todayTokens("sub-a", NOW)).toBe(20_000);
  });

  it("status: budget=0 は無制限 (blocked=false)", async () => {
    addSession("s500", NOW, "sub-a"); // 500k
    const tracker = new SubsidiaryBudgetTracker({ sessionsRepo: repo, readUsage: readUsageStub, now: () => NOW });
    const st = await tracker.status({ id: "sub-a", daily_token_budget: 0 }, NOW);
    expect(st.todayTokens).toBe(500_000);
    expect(st.budget).toBe(0);
    expect(st.blocked).toBe(false);
  });

  it("status: 消費 >= 予算で blocked=true", async () => {
    addSession("s100", NOW, "sub-a"); // 100k
    const tracker = new SubsidiaryBudgetTracker({ sessionsRepo: repo, readUsage: readUsageStub, now: () => NOW });
    expect((await tracker.status({ id: "sub-a", daily_token_budget: 100_000 }, NOW)).blocked).toBe(true);
    expect((await tracker.status({ id: "sub-a", daily_token_budget: 100_001 }, NOW)).blocked).toBe(false);
  });

  it("isOverBudget は status.blocked のショートカット", async () => {
    addSession("s100", NOW, "sub-a");
    const tracker = new SubsidiaryBudgetTracker({ sessionsRepo: repo, readUsage: readUsageStub, now: () => NOW });
    expect(await tracker.isOverBudget({ id: "sub-a", daily_token_budget: 50_000 }, NOW)).toBe(true);
    expect(await tracker.isOverBudget({ id: "sub-a", daily_token_budget: 0 }, NOW)).toBe(false);
  });
});
