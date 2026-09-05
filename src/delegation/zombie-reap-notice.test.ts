import { describe, expect, it } from "vitest";
import { buildZombieReapNotice } from "./zombie-reap-notice.js";
import type { ReapResult } from "./finished-run-reaper.js";

function result(overrides: {
  runId?: string;
  pid?: number;
  status?: "completed" | "failed";
  lingeringMs?: number;
  stop?: ReapResult["stop"];
} = {}): ReapResult {
  return {
    zombie: {
      run_id: overrides.runId ?? "a8960b47-1111-2222-3333-444455556666",
      child_session_id: "lictor-child",
      lictor_pid: overrides.pid ?? 24956,
      finished_at: 1_788_000_000_000,
      lingering_ms: overrides.lingeringMs ?? 4.6 * 3_600_000,
      status: overrides.status ?? "failed",
    },
    stop: overrides.stop ?? { ok: true, method: "taskkill" },
  };
}

describe("buildZombieReapNotice", () => {
  it("returns null when nothing was reaped (do not notify on a quiet sweep)", () => {
    expect(buildZombieReapNotice([])).toBeNull();
  });

  it("summarises how many were stopped", () => {
    const text = buildZombieReapNotice([result(), result({ pid: 999 })])!;
    expect(text).toContain("残留プロセスを 2 件停止しました");
    expect(text).not.toContain("停止に失敗");
  });

  it("calls out failures separately without throwing", () => {
    const privateError = "sensitive OS error detail";
    const text = buildZombieReapNotice([
      result(),
      result({ pid: 5396, stop: { ok: false, error: privateError } }),
    ])!;
    expect(text).toContain("1 件停止しました");
    expect(text).toContain("1 件は停止に失敗");
    expect(text).toContain("→ 失敗");
    expect(text).not.toContain(privateError);
  });

  it("lists run id, pid, status and lingering hours per entry", () => {
    const text = buildZombieReapNotice([result({ lingeringMs: 64.1 * 3_600_000 })])!;
    expect(text).toContain("run a8960b47");
    expect(text).toContain("pid 24956");
    expect(text).toContain("failed");
    expect(text).toContain("64.1h");
  });

  it("never writes a raw mention into the body (mentions go through mention_user_ids)", () => {
    // 本文に <@id> を書くと、 egress の allowedMentions を通らない経路で人が呼ばれうる。
    const text = buildZombieReapNotice([result(), result({ pid: 1 })])!;
    expect(text).not.toMatch(/<@/);
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("@here");
  });

  it("caps the listing and reports the remainder as a count", () => {
    const many = Array.from({ length: 14 }, (_, i) => result({ pid: 1000 + i }));
    const text = buildZombieReapNotice(many)!;
    expect(text).toContain("14 件停止しました");
    expect(text).toContain("ほか 4 件");
    expect(text.split("\n").filter((line) => line.startsWith("- pid") || line.startsWith("- run"))).toHaveLength(10);
  });
});
