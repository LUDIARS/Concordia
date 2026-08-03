import { describe, it, expect } from "vitest";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitForRun, commitFromRequestFile, parseChangedPaths } from "./commit-broker.js";
import { COMMIT_REQUEST_FILENAME } from "./commit-request.js";

// 変更数は too_many_changes の入力なので、 数え漏れ = 上限の素通りになる。
describe("parseChangedPaths", () => {
  it("XY prefix を落として path を返す", () => {
    expect(parseChangedPaths(" M src/a.ts\n?? docs/b.md\n")).toEqual(["src/a.ts", "docs/b.md"]);
  });

  it("rename は新しい方を採る", () => {
    expect(parseChangedPaths("R  old/a.ts -> new/a.ts\n")).toEqual(["new/a.ts"]);
  });

  it("空行を無視する", () => {
    expect(parseChangedPaths("")).toEqual([]);
    expect(parseChangedPaths("\n\n")).toEqual([]);
  });

  it("-uall なら未追跡ファイルが 1 行ずつ数えられる", () => {
    const porcelain = ["?? new/a.ts", "?? new/b.ts", "?? new/c.ts"].join("\n");
    expect(parseChangedPaths(porcelain)).toHaveLength(3);
  });

  it("引用符付きパスの引用符を外す", () => {
    expect(parseChangedPaths('?? "src/\\346\\227\\245.ts"\n')).toEqual(["src/\\346\\227\\245.ts"]);
  });
});

// git を叩かずに到達できる分岐だけを見る (git 実行を伴う経路は実リポジトリでの確認が要る)。
describe("commitFromRequestFile", () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "concordia-broker-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const exists = async (p: string): Promise<boolean> => access(p).then(() => true, () => false);

  it("spawn_cwd が無ければ何もしない (null)", async () => {
    expect(await commitFromRequestFile({ id: "r1" })).toBeNull();
  });

  it("依頼ファイルが無ければ何もしない (null = 正常系)", async () => {
    await withTempDir(async (dir) => {
      expect(await commitFromRequestFile({ id: "r1", spawn_cwd: dir })).toBeNull();
    });
  });

  // 黙って捨てると、 委託先は依頼を出したのに委託元が永久に気付けない。
  it("壊れた依頼は invalid_request を返し、 ファイルは消す", async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, COMMIT_REQUEST_FILENAME);
      await writeFile(file, "{ not json", "utf8");
      const outcome = await commitFromRequestFile({ id: "r1", spawn_cwd: dir });
      expect(outcome).toMatchObject({ ok: false, code: "invalid_request" });
      // 残すと後続 run の `git add -A` が依頼そのものを履歴へ入れる。
      expect(await exists(file)).toBe(false);
    });
  });
});

describe("commitForRun", () => {
  it("spawn_cwd の無い run は git に触れず拒否する", async () => {
    const outcome = await commitForRun({ id: "r1" }, { message: "feat: x" });
    expect(outcome).toMatchObject({ ok: false, code: "run_cwd_unknown" });
  });
});
