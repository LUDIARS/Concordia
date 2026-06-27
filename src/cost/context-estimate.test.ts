import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readClaudeContextTokens,
  readCodexContextTokens,
  toEstimate,
  formatContextBadge,
} from "./context-estimate.js";

const tmps: string[] = [];
function fixture(lines: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "ctx-"));
  tmps.push(dir);
  const p = join(dir, "log.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return p;
}
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readClaudeContextTokens", () => {
  it("最後の assistant usage スナップショット (input+両cache) を返す", () => {
    const p = fixture([
      { message: { id: "m1", usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 } } },
      { message: { id: "m2", usage: { input_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 8 } } },
    ]);
    // 最後の行: 20 + 1000 + 200 = 1220
    expect(readClaudeContextTokens(p)).toBe(1220);
  });
  it("usage が無ければ null", () => {
    expect(readClaudeContextTokens(fixture([{ message: { role: "user" } }]))).toBeNull();
  });
});

describe("readCodexContextTokens", () => {
  it("最後の token_count の input+cached を返す", () => {
    const p = fixture([
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 5, cached_input_tokens: 50 } } } },
      { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 30, cached_input_tokens: 900 } } } },
    ]);
    expect(readCodexContextTokens(p)).toBe(930);
  });
});

describe("toEstimate / formatContextBadge", () => {
  it("pct を 0..1 に丸める", () => {
    expect(toEstimate(100000, 200000).pct).toBe(0.5);
    expect(toEstimate(500000, 200000).pct).toBe(1);
  });
  it("badge を整形する", () => {
    expect(formatContextBadge(toEstimate(124000, 200000))).toBe("🧠 ctx ~62% (124k)");
    expect(formatContextBadge(null)).toBe("");
  });
});
