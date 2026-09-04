import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { CostOneShotCallsRepo } from "./cost-one-shot-calls-repo.js";

let db: ReturnType<typeof makeTestDb>;
let repo: CostOneShotCallsRepo;

beforeEach(() => {
  db = makeTestDb();
  repo = new CostOneShotCallsRepo(db);
});

function insert(overrides: Partial<Parameters<CostOneShotCallsRepo["insert"]>[0]> = {}): number {
  return repo.insert({
    service: "anatomia",
    provider: "claude",
    command: "claude -p",
    prompt: "hello",
    status: "ok",
    input_tokens: 2,
    output_tokens: 554,
    cost_usd: 0.1,
    ...overrides,
  });
}

describe("CostOneShotCallsRepo / listRecent", () => {
  // prompt は 1 件で最大 1MB あり、 limit は 500 まで許す。 一覧に本文を載せると
  // 応答が数百 MB になりうるので、 本文は返さず長さだけ返す。
  it("returns the prompt length instead of the prompt body", () => {
    insert({ prompt: "a".repeat(50_000) });

    const [row] = repo.listRecent();
    expect(row).not.toHaveProperty("prompt");
    expect(row?.prompt_chars).toBe(50_000);
  });

  it("still stores the prompt body even though the listing omits it", () => {
    insert({ prompt: "secret plan" });

    const stored = db
      .prepare("SELECT prompt FROM cost_one_shot_calls ORDER BY id DESC LIMIT 1")
      .get() as { prompt: string };
    expect(stored.prompt).toBe("secret plan");
  });

  it("reports zero characters for an empty prompt", () => {
    insert({ prompt: "" });

    expect(repo.listRecent()[0]?.prompt_chars).toBe(0);
  });

  // SQLite の LENGTH() はバイト数ではなく code point 数を数える。 絵文字 1 文字を
  // 2 と数えないことを固定しておく (prompt_chars は本文の代わりに出す唯一の手がかり)。
  it("counts Unicode code points", () => {
    insert({ prompt: "a\u{1F600}" });

    expect(repo.listRecent()[0]?.prompt_chars).toBe(2);
  });

  it("keeps the cost and token columns the listing exists for", () => {
    insert({ ts: 1000, model: "claude-opus-5", cwd: "E:/Document/Ars", total_tokens: 556 });

    const [row] = repo.listRecent();
    expect(row).toMatchObject({
      ts: 1000,
      service: "anatomia",
      provider: "claude",
      model: "claude-opus-5",
      cwd: "E:/Document/Ars",
      input_tokens: 2,
      output_tokens: 554,
      total_tokens: 556,
      cost_usd: 0.1,
      status: "ok",
    });
  });

  it("returns the newest call first and honours the limit", () => {
    insert({ ts: 1000, prompt: "old" });
    insert({ ts: 3000, prompt: "newest" });
    insert({ ts: 2000, prompt: "middle" });

    expect(repo.listRecent().map((r) => r.ts)).toEqual([3000, 2000, 1000]);
    expect(repo.listRecent(1).map((r) => r.ts)).toEqual([3000]);
  });
});
