import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildExternalDocBundle,
  capContent,
  collectExternalDocRefs,
  EXTERNAL_DOC_MAX_BYTES,
} from "./external-docs.js";

/**
 * 2026-09-05 の問題ログ: 委託文が cwd 外 (別リポ) の設計書をパスで示しただけだったので
 * 子は読めず、 前提を欠いたまま人へ質問して止まった。 明示された参照だけを、 登録済み
 * repo の中にあることを確かめてから同梱する。
 */
describe("collectExternalDocRefs", () => {
  it("memory_links と allowlist した file-ref input だけを拾う", () => {
    const refs = collectExternalDocRefs({
      args: {
        design_path: "E:/repo/spec/design.md",
        task: "E:/secret/notes.md を読んで直す",
        context_extra: "C:/Users/someone/private.md も参考に",
      },
      memoryLinks: ["E:/repo/spec/plan.md", "  "],
    });
    expect(refs).toEqual(["E:/repo/spec/plan.md", "E:/repo/spec/design.md"]);
  });

  it("同じ参照は 1 度だけにする", () => {
    const refs = collectExternalDocRefs({
      args: { design_path: "E:/repo/a.md" },
      memoryLinks: ["E:/repo/a.md"],
    });
    expect(refs).toEqual(["E:/repo/a.md"]);
  });
});

describe("capContent", () => {
  it("byte 上限では完全な文字の境界まで戻して切る", () => {
    // 「あ」は UTF-8 で 3 byte。 4 byte で切ると 2 文字目の途中になる。
    const { text, truncated } = capContent(Buffer.from("あああ", "utf8"), 4, 100);
    expect(text).toBe("あ");
    expect(truncated).toBe(true);
  });

  it("行数上限でも切る", () => {
    const { text, truncated } = capContent(Buffer.from("a\nb\nc\nd", "utf8"), 1024, 2);
    expect(text).toBe("a\nb");
    expect(truncated).toBe(true);
  });

  it("上限内なら素通しする", () => {
    const { text, truncated } = capContent(Buffer.from("hello", "utf8"), 1024, 100);
    expect(text).toBe("hello");
    expect(truncated).toBe(false);
  });
});

describe("buildExternalDocBundle", () => {
  let root: string;
  let otherRepo: string;
  let workRepo: string;
  let worktree: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cc-docs-"));
    otherRepo = join(root, "Augur");
    workRepo = join(root, "Concordia");
    worktree = join(root, "Concordia-feat-x");
    for (const dir of [join(otherRepo, "spec"), join(workRepo, "spec"), join(worktree, "spec")]) {
      mkdirSync(dir, { recursive: true });
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const repos = () => [
    { project: "Augur", repo_path: otherRepo },
    { project: "Concordia", repo_path: workRepo },
  ];

  it("別の登録済み repo にある md は本文を同梱し、 run 用ラベルを返す", () => {
    const path = join(otherRepo, "spec", "live-contract-testing.md");
    writeFileSync(path, "# 契約テスト\n\n受け入れ条件は契約書式で書く。", "utf8");
    const bundle = buildExternalDocBundle({
      refs: [path],
      spawnCwd: worktree,
      spawnRepoPath: workRepo,
      repos: repos(),
    });
    expect(bundle.labels).toEqual(["Augur:spec/live-contract-testing.md"]);
    expect(bundle.section).toContain("## 同梱正本 (別リポの文書)");
    expect(bundle.section).toContain("### Augur:spec/live-contract-testing.md");
    expect(bundle.section).toContain("受け入れ条件は契約書式で書く。");
    // 絶対パスは run にも prompt の見出しにも残さない。
    expect(bundle.labels.join()).not.toContain(root);
  });

  it("上限を超えた md は省略注記付きで切り詰める", () => {
    const path = join(otherRepo, "spec", "huge.md");
    writeFileSync(path, "x".repeat(EXTERNAL_DOC_MAX_BYTES + 100), "utf8");
    const bundle = buildExternalDocBundle({
      refs: [path],
      spawnCwd: worktree,
      spawnRepoPath: workRepo,
      repos: repos(),
      maxBytes: 64,
    });
    expect(bundle.labels).toEqual(["Augur:spec/huge.md"]);
    expect(bundle.section).toContain("上限で省略");
    expect(bundle.section).not.toContain("x".repeat(100));
  });

  it("複数文書でも byte 上限を prompt 全体で共有する", () => {
    const first = join(otherRepo, "spec", "first.md");
    const second = join(otherRepo, "spec", "second.md");
    writeFileSync(first, "a".repeat(40), "utf8");
    writeFileSync(second, "b".repeat(40), "utf8");
    const bundle = buildExternalDocBundle({
      refs: [first, second],
      spawnCwd: worktree,
      spawnRepoPath: workRepo,
      repos: repos(),
      maxBytes: 64,
    });
    expect(bundle.labels).toEqual(["Augur:spec/first.md", "Augur:spec/second.md"]);
    expect(bundle.section).toContain("a".repeat(40));
    expect(bundle.section).toContain("b".repeat(24));
    expect(bundle.section).not.toContain("b".repeat(25));
  });

  it("spawn cwd の中にある md は展開しない (子が直接読める)", () => {
    const path = join(worktree, "spec", "task.md");
    writeFileSync(path, "worktree の中の正本", "utf8");
    const bundle = buildExternalDocBundle({
      refs: [path],
      spawnCwd: worktree,
      spawnRepoPath: workRepo,
      repos: repos(),
    });
    expect(bundle.labels).toEqual([]);
    expect(bundle.section).not.toContain("worktree の中の正本");
    expect(bundle.section).toContain("作業ディレクトリの中にある");
  });

  it("作業対象と同じ repo の md も展開しない", () => {
    const path = join(workRepo, "spec", "same-repo.md");
    writeFileSync(path, "同じ repo の正本", "utf8");
    const bundle = buildExternalDocBundle({
      refs: [path],
      spawnCwd: worktree,
      spawnRepoPath: workRepo,
      repos: repos(),
    });
    expect(bundle.labels).toEqual([]);
    expect(bundle.section).toContain("作業対象と同じ repo");
  });

  it("未登録ディレクトリの md は読まず、 理由付きの非同梱注記だけを出す", () => {
    const outside = join(root, "Elsewhere");
    mkdirSync(outside, { recursive: true });
    const path = join(outside, "private.md");
    writeFileSync(path, "登録外の秘密", "utf8");
    const bundle = buildExternalDocBundle({
      refs: [path],
      spawnCwd: worktree,
      spawnRepoPath: workRepo,
      repos: repos(),
    });
    expect(bundle.labels).toEqual([]);
    expect(bundle.section).not.toContain("登録外の秘密");
    expect(bundle.section).not.toContain(path);
    expect(bundle.section).toContain("登録済み repo の外にある");
  });

  it("md 名の symlink でも実体が md でなければ読まない", () => {
    const alias = join(otherRepo, "spec", "alias.md");
    const target = join(otherRepo, "spec", "secret.txt");
    let readCalled = false;
    const bundle = buildExternalDocBundle({
      refs: [alias],
      spawnCwd: worktree,
      spawnRepoPath: workRepo,
      repos: repos(),
      fs: {
        realpath: (path) => path === alias ? target : path,
        isFile: () => true,
        read: () => { readCalled = true; return Buffer.from("secret"); },
      },
    });
    expect(bundle.labels).toEqual([]);
    expect(readCalled).toBe(false);
    expect(bundle.section).toContain("実体が md ではない");
  });

  it("相対パス・URL・md 以外・存在しないパスは同梱しない", () => {
    const bundle = buildExternalDocBundle({
      refs: ["spec/relative.md", "https://example.com/a.md", join(otherRepo, "spec", "x.txt"), join(otherRepo, "nope.md")],
      spawnCwd: worktree,
      spawnRepoPath: workRepo,
      repos: repos(),
    });
    expect(bundle.labels).toEqual([]);
    expect(bundle.skipped.map((item) => item.reason)).toEqual([
      "相対パスは基準が定まらないので同梱しない",
      "URL は同梱しない (子が必要なら自分で取得する)",
      "md 以外は同梱しない",
      "パスを解決できない (存在しない / 権限が無い)",
    ]);
  });

  it("参照が無ければ節そのものを作らない", () => {
    const bundle = buildExternalDocBundle({ refs: [], spawnCwd: worktree, repos: repos() });
    expect(bundle.section).toBe("");
    expect(bundle.labels).toEqual([]);
  });
});
