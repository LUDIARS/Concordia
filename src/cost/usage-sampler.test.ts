import { describe, it, expect } from "vitest";
import { collectUsageSamples, type UsageSampleReader } from "./usage-sampler.js";
import type { SessionRow } from "../shared/types.js";

function sess(id: string, metadata: string | null = null, provider: SessionRow["provider"] = "claude-code"): SessionRow {
  return {
    id, provider, repo_path: "/x", repo_origin: null, branch: null, host: "h",
    started_at: 0, ended_at: null, status: "active", last_seen_at: 0,
    current_task: null, transcript_path: null, metadata, ws_clients: 0,
  };
}

describe("collectUsageSamples", () => {
  const reader: UsageSampleReader = {
    context: (s) => (s.id === "a" ? 50000 : null), // b/c は context 不明
    cost: (s) => ({ a: 1_000_000, b: 2000, c: 0 }[s.id] ?? 0),
  };

  it("context/cost を読み subsidiary_id / provider を焼いて行にする", () => {
    const out = collectUsageSamples([sess("a", JSON.stringify({ subsidiary_id: "sub-1" }))], 1234, reader);
    expect(out).toEqual([
      { ts: 1234, session_id: "a", subsidiary_id: "sub-1", provider: "claude-code", context_tokens: 50000, cost_tokens: 1_000_000 },
    ]);
  });

  it("context も cost も無い (まだ何も使ってない) セッションは記録しない", () => {
    const out = collectUsageSamples([sess("c")], 1, reader); // c: context null, cost 0 → skip
    expect(out).toHaveLength(0);
  });

  it("context 不明でも cost>0 なら記録する (context_tokens=null)", () => {
    const out = collectUsageSamples([sess("b")], 1, reader); // b: context null, cost 2000
    expect(out).toHaveLength(1);
    expect(out[0].context_tokens).toBeNull();
    expect(out[0].cost_tokens).toBe(2000);
  });

  it("subsidiary_id 無し (本社) は null", () => {
    const out = collectUsageSamples([sess("a")], 1, reader);
    expect(out[0].subsidiary_id).toBeNull();
  });
});
