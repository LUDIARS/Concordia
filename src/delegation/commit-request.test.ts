import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMIT_REQUEST_FILENAME,
  parseCommitRequest,
  readCommitRequest,
  removeCommitRequest,
} from "./commit-request.js";

describe("parseCommitRequest", () => {
  it("message だけなら paths 無しで通る", () => {
    expect(parseCommitRequest({ message: "feat: x" })).toEqual({ message: "feat: x" });
  });

  it("前後の空白を落とす", () => {
    expect(parseCommitRequest({ message: "  feat: x  " })).toEqual({ message: "feat: x" });
  });

  it("message が無い / 空なら拒否", () => {
    expect(parseCommitRequest({})).toBeNull();
    expect(parseCommitRequest({ message: "   " })).toBeNull();
    expect(parseCommitRequest({ message: 42 })).toBeNull();
  });

  it("オブジェクトでなければ拒否", () => {
    expect(parseCommitRequest(null)).toBeNull();
    expect(parseCommitRequest("feat: x")).toBeNull();
    expect(parseCommitRequest([{ message: "x" }])).toBeNull();
  });

  it("相対パスの配列は通る", () => {
    expect(parseCommitRequest({ message: "m", paths: ["src/a.ts", "docs/b.md"] }))
      .toEqual({ message: "m", paths: ["src/a.ts", "docs/b.md"] });
  });

  it("絶対パスは拒否 (worktree 外を stage させない)", () => {
    expect(parseCommitRequest({ message: "m", paths: ["/etc/passwd"] })).toBeNull();
    expect(parseCommitRequest({ message: "m", paths: ["C:\\Windows\\x"] })).toBeNull();
    expect(parseCommitRequest({ message: "m", paths: ["\\\\server\\share"] })).toBeNull();
  });

  it("親参照は拒否", () => {
    expect(parseCommitRequest({ message: "m", paths: ["../other/a.ts"] })).toBeNull();
    expect(parseCommitRequest({ message: "m", paths: ["src/../../a.ts"] })).toBeNull();
  });

  it("paths が空配列なら message だけ扱い", () => {
    expect(parseCommitRequest({ message: "m", paths: [] })).toEqual({ message: "m" });
  });

  it("paths に文字列以外が混ざったら拒否", () => {
    expect(parseCommitRequest({ message: "m", paths: ["ok.ts", 1] })).toBeNull();
  });

  // `git add -- <path>` の `--` はオプション解析を止めるだけで pathspec magic は生きる。
  it("git pathspec magic (先頭 `:`) は拒否", () => {
    expect(parseCommitRequest({ message: "m", paths: [":/"] })).toBeNull();
    expect(parseCommitRequest({ message: "m", paths: [":(exclude)src/a.ts"] })).toBeNull();
  });
});

describe("readCommitRequest", () => {
  async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "concordia-commit-req-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("依頼が無ければ none (正常系)", async () => {
    await withTempDir(async (dir) => {
      expect(await readCommitRequest(dir)).toEqual({ kind: "none" });
    });
  });

  it("正しい依頼なら ok", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, COMMIT_REQUEST_FILENAME), JSON.stringify({ message: "feat: x" }), "utf8");
      expect(await readCommitRequest(dir)).toEqual({ kind: "ok", request: { message: "feat: x" } });
    });
  });

  // 「無い」 と混ぜると、 依頼を出したのに黙って捨てられて委託元が永久に気付けない。
  it("JSON が壊れていたら invalid (none と区別する)", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, COMMIT_REQUEST_FILENAME), "{ not json", "utf8");
      const read = await readCommitRequest(dir);
      expect(read.kind).toBe("invalid");
    });
  });

  it("形が違えば invalid", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, COMMIT_REQUEST_FILENAME), JSON.stringify({ paths: ["a.ts"] }), "utf8");
      const read = await readCommitRequest(dir);
      expect(read.kind).toBe("invalid");
    });
  });

  it("removeCommitRequest 後は none に戻る / 無くても投げない", async () => {
    await withTempDir(async (dir) => {
      await removeCommitRequest(dir); // 無い状態でも throw しない
      await writeFile(join(dir, COMMIT_REQUEST_FILENAME), JSON.stringify({ message: "m" }), "utf8");
      await removeCommitRequest(dir);
      expect(await readCommitRequest(dir)).toEqual({ kind: "none" });
    });
  });
});
