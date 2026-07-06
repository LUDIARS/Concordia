import { describe, it, expect } from "vitest";
import {
  normalizeRepoKey,
  isWorkspaceRootRepo,
  conflictRepoKey,
  findConflictPeers,
} from "../src/control/conflict-scope.js";

const ROOTS = ["E:/Document/Ars"];

function s(id: string, repo_path: string, target_project: string | null = null, status = "active") {
  return { id, repo_path, target_project, status, branch: null };
}

describe("normalizeRepoKey", () => {
  it("バックスラッシュ / 大文字小文字 / 末尾スラッシュを吸収", () => {
    expect(normalizeRepoKey("E:\\Document\\Ars\\Memoria")).toBe("e:/document/ars/memoria");
    expect(normalizeRepoKey("E:/Document/Ars/")).toBe("e:/document/ars");
  });
});

describe("isWorkspaceRootRepo", () => {
  it("設定ルートと一致すれば true (表記揺れ込み)", () => {
    expect(isWorkspaceRootRepo("E:\\Document\\Ars", ROOTS)).toBe(true);
    expect(isWorkspaceRootRepo("E:/Document/Ars/", ROOTS)).toBe(true);
  });
  it("子リポは false", () => {
    expect(isWorkspaceRootRepo("E:/Document/Ars/Memoria", ROOTS)).toBe(false);
  });
});

describe("conflictRepoKey", () => {
  it("要件1: repo_path がルート & 未宣言 → null (umbrella は衝突監視しない)", () => {
    expect(conflictRepoKey(s("a", "E:/Document/Ars"), ROOTS)).toBeNull();
  });
  it("要件2: target_project 宣言時はそれをキーにする (cwd がルートでも)", () => {
    expect(conflictRepoKey(s("a", "E:/Document/Ars", "E:/Document/Ars/Memoria"), ROOTS)).toBe(
      "e:/document/ars/memoria",
    );
  });
  it("子リポを直接 cwd にした通常ケースは repo_path をキーにする", () => {
    expect(conflictRepoKey(s("a", "E:/Document/Ars/Lictor"), ROOTS)).toBe("e:/document/ars/lictor");
  });
});

describe("findConflictPeers", () => {
  it("ルート cwd の未宣言セッション同士は衝突しない (要件1)", () => {
    const active = [s("a", "E:/Document/Ars"), s("b", "E:/Document/Ars")];
    expect(findConflictPeers(active[0], active, ROOTS)).toEqual([]);
  });

  it("同じ target_project を宣言した2セッションは衝突する (要件2、cwd がルートでも)", () => {
    const active = [
      s("a", "E:/Document/Ars", "Memoria"),
      s("b", "E:/Document/Ars", "Memoria"),
      s("c", "E:/Document/Ars", "Lictor"),
      s("d", "E:/Document/Ars"), // 未宣言 root → 対象外
    ];
    const peers = findConflictPeers(active[0], active, ROOTS);
    expect(peers.map((p) => p.id)).toEqual(["b"]);
  });

  it("子リポ直 cwd は従来どおり repo_path で衝突する", () => {
    const active = [
      s("a", "E:/Document/Ars/Lictor"),
      s("b", "E:/Document/Ars/Lictor"),
      s("c", "E:/Document/Ars/Memoria"),
    ];
    expect(findConflictPeers(active[0], active, ROOTS).map((p) => p.id)).toEqual(["b"]);
  });

  it("宣言 target_project と 子リポ直 cwd が同じ実体なら衝突する (正規化一致)", () => {
    const active = [
      s("a", "E:/Document/Ars", "E:/Document/Ars/Memoria"),
      s("b", "E:/Document/Ars/Memoria"),
    ];
    expect(findConflictPeers(active[0], active, ROOTS).map((p) => p.id)).toEqual(["b"]);
  });

  it("非 active は除外する", () => {
    const active = [
      s("a", "E:/Document/Ars/Lictor"),
      s("b", "E:/Document/Ars/Lictor", null, "lost"),
    ];
    expect(findConflictPeers(active[0], active, ROOTS)).toEqual([]);
  });
});
