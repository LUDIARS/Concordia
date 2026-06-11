import { describe, it, expect } from "vitest";
import { aggregateBullets, generateReport, templateSummary } from "../src/report/generator.js";
import type { SessionEventRow, SessionRow } from "../src/shared/types.js";

const session: SessionRow = {
  id: "s1", provider: "claude-code", repo_path: "/x",
  repo_origin: "origin", branch: "main", host: "h",
  started_at: 100, ended_at: 700, status: "ended", last_seen_at: 700,
  current_task: null, transcript_path: null, metadata: null, ws_clients: 0,
};

function ev(kind: string, ts: number, payload: object = {}): SessionEventRow {
  return { id: 0, session_id: "s1", ts, kind, payload: JSON.stringify(payload) };
}

describe("aggregateBullets", () => {
  it("counts events and gathers files", () => {
    const events: SessionEventRow[] = [
      ev("prompt", 110),
      ev("prompt", 120),
      ev("edit", 130, { file: "src/a.ts" }),
      ev("edit", 140, { file: "src/b.ts" }),
      ev("compact", 200),
      ev("task_update", 210, { todos: [
        { status: "completed", subject: "x" },
        { status: "completed", subject: "y" },
        { status: "in_progress", subject: "z" },
      ] }),
      ev("end", 700),
    ];
    const b = aggregateBullets(session, events);
    expect(b.duration_sec).toBe(600);
    expect(b.events.prompt).toBe(2);
    expect(b.events.edit).toBe(2);
    expect(b.files.edited.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(b.todos).toEqual({ completed: 2, in_progress: 1, pending: 0 });
    expect(b.outcome).toBe("ended");
  });

  it("templateSummary produces markdown with key sections", () => {
    const b = aggregateBullets(session, [ev("prompt", 110), ev("edit", 120, { file: "f.ts" })]);
    const md = templateSummary(session, b);
    expect(md).toMatch(/^# Session s1/);
    expect(md).toContain("provider");
    expect(md).toContain("Activity");
    expect(md).toContain("Files");
  });

  it("handles lost outcome", () => {
    const lost: SessionRow = { ...session, status: "lost", ended_at: null };
    const b = aggregateBullets(lost, [ev("prompt", 110)]);
    expect(b.outcome).toBe("lost");
  });

  it("fallback summary preserves 3 セクション (poem / template / summary) when AI fails", async () => {
    process.env.CONCORDIA_DISABLE_CLAUDE = "1";
    try {
      const events: SessionEventRow[] = [
        ev("prompt", 110),
        ev("edit", 120, { file: "src/foo.ts" }),
      ];
      // apiKey 空で Anthropic API も skip → templateSummary fallback 経路に必ず入る
      const r = await generateReport(session, events, { apiKey: "", model: "x" });
      const md = r.summary_md;
      const sepCount = (md.match(/\n---\n/g) ?? []).length;
      expect(sepCount).toBeGreaterThanOrEqual(2); // poem | middle | summary
      expect(md).toMatch(/雑用係|narrative 生成|ポエム|placeholder/);
      expect(md).toContain("## サマリ");
      // 冒頭 (extractMonologue 対象) は --- 前に置かれていて非空
      const head = md.split(/\n---/)[0].trim();
      expect(head.length).toBeGreaterThan(0);
    } finally {
      delete process.env.CONCORDIA_DISABLE_CLAUDE;
    }
  });
});
