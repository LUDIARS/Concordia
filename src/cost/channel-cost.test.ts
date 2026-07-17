import { describe, it, expect } from "vitest";
import {
  collectChannelCostRows,
  fmtTokensCompact,
  renderChannelCostLines,
  type ChannelCostReader,
} from "./channel-cost.js";
import type { SessionRow } from "../shared/types.js";

function sess(id: string, provider: SessionRow["provider"] = "claude-code"): SessionRow {
  return {
    id,
    provider,
    repo_path: "/x",
    repo_origin: null,
    branch: null,
    host: "h",
    started_at: 0,
    ended_at: null,
    status: "active",
    last_seen_at: 0,
    current_task: null,
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
    target_project: null,
  };
}

describe("fmtTokensCompact", () => {
  it("null は —、 1000 未満は素の数、 k/M に丸める", () => {
    expect(fmtTokensCompact(null)).toBe("—");
    expect(fmtTokensCompact(0)).toBe("0");
    expect(fmtTokensCompact(940)).toBe("940");
    expect(fmtTokensCompact(45200)).toBe("45.2k");
    expect(fmtTokensCompact(1_230_000)).toBe("1.23M");
  });
});

describe("collectChannelCostRows", () => {
  const reader: ChannelCostReader = {
    context: async (s) => (s.id === "c" ? null : ({ a: 50000, b: 120000 }[s.id] ?? 0)),
    cost: async (s) => ({ a: 2_000_000, b: 500_000, c: 9_000 }[s.id] ?? 0),
  };

  it("コンテキスト降順 (null は末尾)、 同点はコスト降順で並べる", async () => {
    const rows = await collectChannelCostRows(
      [sess("a"), sess("b"), sess("c")],
      (id) => (id === "c" ? null : `chan-${id}`),
      reader,
    );
    expect(rows.map((r) => r.sessionId)).toEqual(["b", "a", "c"]);
    expect(rows[0].channelId).toBe("chan-b");
    expect(rows[2].channelId).toBeNull(); // c は未マッピング
    expect(rows[2].contextTokens).toBeNull();
  });

  it("同コンテキストはコスト降順でタイブレーク", async () => {
    const r2: ChannelCostReader = {
      context: async () => 1000,
      cost: async (s) => (s.id === "hi" ? 999 : 111),
    };
    const rows = await collectChannelCostRows([sess("lo"), sess("hi")], () => null, r2);
    expect(rows.map((r) => r.sessionId)).toEqual(["hi", "lo"]);
  });
});

describe("renderChannelCostLines", () => {
  it("チャンネルメンション + 🧠/💰 を描く。 未マッピングは session id 8 桁", () => {
    const lines = renderChannelCostLines([
      { sessionId: "abcdefgh1234", channelId: "111", provider: "claude-code", contextTokens: 120000, costTokens: 500000 },
      { sessionId: "zzzzzzzz9999", channelId: null, provider: "codex-cli", contextTokens: null, costTokens: 9000 },
    ]);
    expect(lines[0]).toContain("チャンネル別");
    expect(lines.some((l) => l.includes("<#111>") && l.includes("🧠 120.0k") && l.includes("💰 500.0k"))).toBe(true);
    expect(lines.some((l) => l.includes("`zzzzzzzz`") && l.includes("🧠 —") && l.includes("💰 9.0k"))).toBe(true);
  });

  it("空ならプレースホルダ行", () => {
    const lines = renderChannelCostLines([]);
    expect(lines.some((l) => l.includes("アクティブセッション無し"))).toBe(true);
  });

  it("limit 超過は残件数を出す", () => {
    const rows = Array.from({ length: 18 }, (_, i) => ({
      sessionId: `s${i}`,
      channelId: `c${i}`,
      provider: "claude-code",
      contextTokens: 1000 - i,
      costTokens: 0,
    }));
    const lines = renderChannelCostLines(rows, 15);
    expect(lines.some((l) => l.includes("他 3 件"))).toBe(true);
  });
});
