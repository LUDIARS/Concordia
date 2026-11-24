import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { makeTestDb } from "../../tests/helpers/db.js";
import { controlSessionRouter } from "../api/control-session.js";
import { createSessionProgressReader } from "./session-progress-reader.js";
import { buildSessionProgress, parseFollowupRate, renderDesktopPlanStatus } from "./session-progress-view.js";
import type { ControlBoardRowWithLink } from "./session-link.js";

function row(id: string): ControlBoardRowWithLink {
  return {
    session_id: id, project: "Cc", branch: "feat/x", followup_state: null, fingerprint: null, unchanged_count: 0, current_task: "作業",
    side_summary: null, side_reported_at: null, last_activity_at: 10, updated_at: 10, digested_fingerprint: null, status: "working",
    status_reason: null, classified_at: null, nudge_count: 0, nudge_last_at: null, unresponsive_reported_at: null, link: null,
  } as ControlBoardRowWithLink;
}

const unknownPhase = { phase: "unknown" as const, revision: 0, design_summary: "", reason: "", approval_reference: null, updated_at: null };

describe("プランと進捗の組み立て (実装メモ 13)", () => {
  it("reads the follow-up rate from the recorded fingerprint and keeps unmeasured as null, not 0", () => {
    expect(parseFollowupRate("abc|rate:40")).toBe(40);
    expect(parseFollowupRate("abc|rate:none")).toBeNull();
    expect(parseFollowupRate(null)).toBeNull();
    expect(parseFollowupRate("abc|rate:999")).toBeNull();
  });

  it("counts steps, falls back to the desktop plan steps and renders its status line", () => {
    const plan = { steps: [{ content: "設計", status: "completed" as const }, { content: "実装", status: "in_progress" as const }], phase: "working" as const, summary: null, updated_at: 1 };
    const view = buildSessionProgress({ row: row("s1"), steps: [], desktopPlan: plan, workPhase: { ...unknownPhase, phase: "implementation", design_summary: "方針" }, followupFingerprint: "x|rate:none", tasks: { state: "unavailable" } });
    expect(view.plan).toEqual({ steps: [{ text: "設計", status: "completed" }, { text: "実装", status: "in_progress" }], desktop_plan_status: "作業中", work_phase: { phase: "implementation", label: "実装", design_summary: "方針" } });
    expect(view.progress).toEqual({ steps_completed: 1, steps_total: 2, followup_rate: null, tasks: { state: "unavailable" } });
    expect(renderDesktopPlanStatus({ ...plan, phase: "waiting", summary: { recap: "確認して", ask: null, choices: [], blocked: false } })).toBe("人の回答待ち — 確認して");
  });
});

describe("GET /v1/control/sessions (実装メモ 13)", () => {
  function setup(readTaskLinks: (id: string) => Promise<Array<{ reference: string; status: string; state: "current" | "unknown" }> | null>) {
    const db = makeTestDb();
    const insert = db.prepare(`INSERT INTO sessions (id, provider, repo_path, host, started_at, status, last_seen_at, metadata, branch)
      VALUES (?, 'claude', 'E:/x', 'h', 1, 'active', 1, ?, 'feat/x')`);
    insert.run("s1", JSON.stringify({ cc_followup_progress: { fingerprint: "f|rate:60", unchanged_count: 0, last_checked_at: 1, last_changed_at: 1 }, cc_task_links: [{ task_reference: "actio:1" }] }));
    insert.run("s2", JSON.stringify({}));
    const records = db.prepare("INSERT INTO session_task_records (session_id, task_text, status, first_seen_at, last_updated_at) VALUES (?, ?, ?, ?, ?)");
    records.run("s1", "調べる", "completed", 1, 1);
    records.run("s1", "直す", "pending", 2, 2);
    const reader = createSessionProgressReader({
      db, boardRows: () => [row("s1"), row("s2")], readTaskLinks, taskLinksCache: { waitMs: 50 },
      hasTaskLinks: (metadata) => (metadata ?? "").includes("cc_task_links"),
    });
    let enabled = true;
    const app = new Hono().route("/v1/control", controlSessionRouter({
      isEnabled: () => enabled, holder: () => null, currentControlSessionId: () => null, boardRows: () => [],
      dispatch: async () => ({ delivered: [], skipped: [] }) as never, sessionProgress: () => reader.read(),
    }));
    return { app, disable: () => { enabled = false; } };
  }

  it("returns board rows with plan and progress, with Actio state per session", async () => {
    const readTaskLinks = vi.fn(async () => [{ reference: "actio:1", status: "in_progress", state: "current" as const }]);
    const { app } = setup(readTaskLinks);
    const started = Date.now();
    const body = await (await app.request("/v1/control/sessions")).json();
    expect(Date.now() - started).toBeLessThan(1000);
    const [s1, s2] = body.items;
    expect(s1.plan.steps).toEqual([{ text: "調べる", status: "completed" }, { text: "直す", status: "pending" }]);
    expect(s1.progress).toEqual({ steps_completed: 1, steps_total: 2, followup_rate: 60, tasks: { state: "ok", items: [{ reference: "actio:1", status: "in_progress", state: "current" }] } });
    expect(s2.progress).toEqual({ steps_completed: 0, steps_total: 0, followup_rate: null, tasks: { state: "ok", items: [] } });
    // 紐付けの無いセッションには Actio を引かない。
    expect(readTaskLinks).toHaveBeenCalledTimes(1);
  });

  it("marks Actio as unavailable on timeout or failure without failing the whole response", async () => {
    const slow = setup(() => new Promise(() => undefined));
    expect((await (await slow.app.request("/v1/control/sessions")).json()).items[0].progress.tasks).toEqual({ state: "unavailable" });
    const failing = setup(async () => { throw new Error("actio down"); });
    expect((await (await failing.app.request("/v1/control/sessions")).json()).items[0].progress.tasks).toEqual({ state: "unavailable" });
  });

  it("does not grow DB or Actio reads with the number of sessions, and answers without waiting for a slow Actio", async () => {
    async function measure(count: number) {
      const db = makeTestDb();
      const insert = db.prepare(`INSERT INTO sessions (id, provider, repo_path, host, started_at, status, last_seen_at, metadata, branch)
        VALUES (?, 'claude', 'E:/x', 'h', 1, 'active', 1, ?, 'feat/x')`);
      const ids = Array.from({ length: count }, (_, i) => `s${i}`);
      for (const id of ids) insert.run(id, JSON.stringify({ cc_task_links: [{ task_reference: "actio:1" }] }));
      // 本番で見た遅い Actio (数秒) の代わり。応答はこれを待たない。
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const readTaskLinks = vi.fn(async () => { await gate; return [{ reference: "actio:1", status: "open", state: "current" as const }]; });
      const reader = createSessionProgressReader({
        db, boardRows: () => ids.map(row), readTaskLinks, hasTaskLinks: () => true, taskLinksCache: { waitMs: 20 },
      });
      const prepare = vi.spyOn(db, "prepare");
      const started = Date.now();
      const first = await reader.read();
      const elapsed = Date.now() - started;
      const preparesPerRead = prepare.mock.calls.length;
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = await reader.read();
      return { first, second, elapsed, preparesPerRead, actioReads: readTaskLinks.mock.calls.length, count };
    }
    const few = await measure(3);
    const many = await measure(30);
    expect(many.preparesPerRead).toBe(few.preparesPerRead);
    expect(few.preparesPerRead).toBeLessThanOrEqual(2);
    expect(many.elapsed).toBeLessThan(300);
    expect(many.first.every((item) => item.progress.tasks.state === "unavailable")).toBe(true);
    // 読み出しは裏で続き、次の表示では覚えた値を返す (2 回の表示で Actio はセッションごとに 1 回だけ)。
    expect(many.second.every((item) => item.progress.tasks.state === "ok")).toBe(true);
    expect(many.actioReads).toBe(many.count);
    expect(few.actioReads).toBe(few.count);
  });

  it("answers 409 while the control patrol is off", async () => {
    const h = setup(async () => []);
    h.disable();
    expect((await h.app.request("/v1/control/sessions")).status).toBe(409);
  });
});
