import { describe, expect, it } from "vitest";

import { listBranchCommits } from "./branch-commits.js";

/**
 * ref は Revisor の登録値 (base) とセッション登録値 (branch) から来るので、 この関数から
 * 見れば外部入力。 git を起動する前に弾けているかだけを見る (git 自体は動かさない)。
 */
describe("listBranchCommits", () => {
  it("refuses refs that git would parse as options or that cannot be branch names", async () => {
    for (const bad of ["--output=/tmp/x", "-C", "", "feat/ a", "feat/x^", "feat:x"]) {
      await expect(listBranchCommits("E:/repo", "main", bad)).rejects.toThrow("unsafe git ref");
      await expect(listBranchCommits("E:/repo", bad, "feat/x")).rejects.toThrow("unsafe git ref");
    }
  });
});
