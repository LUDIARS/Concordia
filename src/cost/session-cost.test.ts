import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readClaudeCost,
  formatCostBadge,
  renderUsageMarkdown,
  type SessionCostEstimate,
} from "./session-cost.js";
import { toEstimate } from "./context-estimate.js";

const tmps: string[] = [];
function fixture(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cost-"));
  tmps.push(dir);
  const p = join(dir, "log.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return p;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readClaudeCost", () => {
  it("model 別単価で input/output/cache を金額化する (cache 5m/1h 内訳を区別)", () => {
    const p = fixture([
      {
        message: {
          id: "m1",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_read_input_tokens: 1_000_000,
            cache_creation_input_tokens: 1_000_000,
            cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 0 },
          },
        },
      },
    ]);
    const est = readClaudeCost(p);
    // input 5 + output 25 + cache_read 5*0.1 + cache_write_5m 5*1.25 = 36.75
    expect(est.usd).toBeCloseTo(36.75, 6);
    expect(est.pricedTokens).toBe(4_000_000);
    expect(est.unpricedTokens).toBe(0);
    expect(est.models).toEqual(["claude-opus-4-8"]);
  });

  it("cache_creation 内訳が無ければ全量 5m 扱い", () => {
    const p = fixture([
      {
        message: {
          id: "m1",
          model: "claude-haiku-4-5",
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 },
        },
      },
    ]);
    // haiku in $1/Mtok × 1.25 (5m write) = 1.25
    expect(readClaudeCost(p).usd).toBeCloseTo(1.25, 6);
  });

  it("message.id で dedup する", () => {
    const row = {
      message: { id: "dup", model: "claude-opus-4-8", usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    };
    expect(readClaudeCost(fixture([row, row])).usd).toBeCloseTo(5, 6);
  });

  it("単価不明 model は未価格トークンに計上し USD に混ぜない", () => {
    const p = fixture([
      { message: { id: "m1", model: "gpt-5-codex", usage: { input_tokens: 500, output_tokens: 500 } } },
    ]);
    const est = readClaudeCost(p);
    expect(est.usd).toBe(0);
    expect(est.pricedTokens).toBe(0);
    expect(est.unpricedTokens).toBe(1000);
  });
});

describe("formatCostBadge", () => {
  const base: SessionCostEstimate = { usd: 0, pricedTokens: 0, unpricedTokens: 0, models: [] };
  it("$1 以上は 2 桁、 未満は 4 桁", () => {
    expect(formatCostBadge({ ...base, usd: 1.2345, pricedTokens: 10 })).toBe("💰 ~$1.23");
    expect(formatCostBadge({ ...base, usd: 0.01234, pricedTokens: 10 })).toBe("💰 ~$0.0123");
  });
  it("未価格トークンは併記する", () => {
    expect(formatCostBadge({ ...base, unpricedTokens: 45000 })).toBe("💰 +45k tok (未価格)");
  });
  it("何も無ければ空文字", () => {
    expect(formatCostBadge(null)).toBe("");
    expect(formatCostBadge(base)).toBe("");
  });
});

describe("renderUsageMarkdown", () => {
  it("コスト + コンテキストを markdown 化する", () => {
    const lines = renderUsageMarkdown({
      context: toEstimate(124000, 200000),
      cost: { usd: 1.23, pricedTokens: 10, unpricedTokens: 0, models: ["claude-opus-4-8"] },
    });
    expect(lines[0]).toBe("## コスト / コンテキスト");
    expect(lines).toContain("- 想定コスト (等価API): ~$1.23 (claude-opus-4-8)");
    expect(lines).toContain("- コンテキスト占有: ~62% (124k / 200k)");
  });
  it("両方 null なら空配列", () => {
    expect(renderUsageMarkdown({ context: null, cost: null })).toEqual([]);
  });
});
