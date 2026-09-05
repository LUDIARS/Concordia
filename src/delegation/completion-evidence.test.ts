import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  requiresCompletionEvidence,
  verifyCompletionEvidence,
  verifyContractAcceptance,
} from "./completion-evidence.js";
import {
  AUGUR_CONTRACTS_FILE,
  augurCliCommand,
  parseAugurAcceptance,
  type AugurRunner,
} from "./augur-acceptance.js";
import { reconcileAcceptance } from "./acceptance-reconcile.js";

// 2026-09-02〜03 に quaestor-mail-sweep / kaizen-daily / deps-sweep-daily /
// vulnerability-response-daily の completed が
// "no completion evidence (spawned checkout has no recorded feature branch)" で
// failed へ落ちていた。 どれも本文が「commit も push も PR もしない」タスクである。
describe("requiresCompletionEvidence", () => {
  it("パートタイマーは feature branch を成果物として要求しない", () => {
    expect(requiresCompletionEvidence("parttimer")).toBe(false);
  });

  it("実装が成果になる雇用形態は引き続きガードする", () => {
    expect(requiresCompletionEvidence("employee")).toBe(true);
    expect(requiresCompletionEvidence("freelancer")).toBe(true);
    expect(requiresCompletionEvidence("test-qa")).toBe(true);
  });

  it("category 不明 (テンプレ削除済みの run) はガードする側に倒す", () => {
    expect(requiresCompletionEvidence(null)).toBe(true);
    expect(requiresCompletionEvidence(undefined)).toBe(true);
  });
});

/**
 * 契約書式の受け入れ条件を置いた委託は、 自己申告 `met` を Augur の集計と突合する
 * (spec/feature/task-workflow.md §5.1)。 Augur は実プロセスなので runner を DI で
 * 差し替え、 突合の判断だけを確かめる (vi.mock は使わない — isolate:false の共有環境で
 * モジュールレジストリを汚さないため)。
 */
describe("verifyCompletionEvidence — 契約書式の受け入れ条件の突合", () => {
  const REPORT = [
    { criterion: "C4-1 buildDelegationContext(): ask マーカー規則を注入する", met: true },
    { criterion: "C4-2 verifyCompletionEvidence(): 自己申告と集計を突合する", met: true },
  ];
  // branch 証跡の判定は通った前提で契約の突合だけを見たいので、 git を触らない
  // review-only ではなく、 契約検査を直接呼ぶための最小 run を用意する。
  const run = {
    spawn_worktree_path: null as string | null,
    spawn_cwd: null as string | null,
    spawn_branch: "feat/x",
    created_at: Date.parse("2026-09-05T00:00:00.000Z"),
  };

  function makeWorktree(withContract: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), "cc-evidence-"));
    if (withContract) writeFileSync(join(dir, AUGUR_CONTRACTS_FILE), "{}", "utf8");
    return dir;
  }

  const runner = (payload: unknown): AugurRunner => async () => JSON.stringify(payload);

  async function verifyContract(
    dir: string,
    options: Parameters<typeof verifyContractAcceptance>[2],
  ) {
    return verifyContractAcceptance(dir, run, options);
  }

  it("契約ファイルが無い委託は Augur を呼ばずに従来判定のまま通る", async () => {
    const dir = makeWorktree(false);
    try {
      let called = false;
      const verdict = await verifyContract(dir, {
        acceptanceReport: REPORT,
        resolveAugurCli: () => { called = true; return "augur.mjs"; },
      });
      expect(verdict).toEqual({ ok: true, checked: true });
      expect(called).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("自己申告と集計が一致する項目だけなら未達を出さない", () => {
    const unmet = reconcileAcceptance(REPORT, [
      { criterion: "C4-1 …", met: true },
      { criterion: "C4-2 …", met: true },
    ]);
    expect(unmet).toEqual([]);
  });

  it("自己申告 true / 集計 false は unmet acceptance として拒否する", () => {
    const unmet = reconcileAcceptance(REPORT, [
      { criterion: "C4-1 …", met: true },
      { criterion: "C4-2 …", met: false },
    ]);
    expect(unmet).toEqual(["C4-2 verifyCompletionEvidence(): 自己申告と集計を突合する"]);
  });

  it("集計に出てこない契約 (covered されていない) も未達として扱う", () => {
    const unmet = reconcileAcceptance(REPORT, [{ criterion: "C4-1 …", met: true }]);
    expect(unmet).toEqual(["C4-2 verifyCompletionEvidence(): 自己申告と集計を突合する"]);
  });

  it("集計済み契約を自己申告から省略して completed を迂回できない", () => {
    const unmet = reconcileAcceptance([], [
      { criterion: "C4-1 buildDelegationContext(): ask マーカー規則を注入する", met: true },
    ]);
    expect(unmet).toEqual(["C4-1 buildDelegationContext(): ask マーカー規則を注入する"]);
  });

  it("Augur JSON の不正項目を黙って捨てず証跡不正として扱う", () => {
    expect(() => parseAugurAcceptance(JSON.stringify([{ criterion: "C4-1 …", met: "yes" }]))).toThrow(
      "augur acceptance item 0 was invalid",
    );
  });

  it("prompt 用 CLI パスを PowerShell literal として引用する", () => {
    expect(augurCliCommand("E:/workspace $x/Augur/bin/augur.mjs"))
      .toBe("node 'E:/workspace $x/Augur/bin/augur.mjs'");
  });

  it("Augur を解決できない端末では、 契約ファイルがある委託を診断付きで拒否する", async () => {
    const dir = makeWorktree(true);
    try {
      const verdict = await verifyContract(dir, {
        acceptanceReport: REPORT,
        resolveAugurCli: () => null,
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toContain("Augur CLI could not be resolved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Augur の実行が落ちたら、 拒否理由に診断を載せる (証跡なしで通さない)", async () => {
    const dir = makeWorktree(true);
    try {
      const verdict = await verifyContract(dir, {
        acceptanceReport: REPORT,
        resolveAugurCli: () => "augur.mjs",
        augurRunner: async () => { throw new Error("spawn ENOENT at LOCAL_SECRET_PATH"); },
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toContain("execution or parsing failed");
      expect(verdict.ok === false && verdict.reason).not.toContain("LOCAL_SECRET_PATH");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("集計が自己申告どおりなら completed を通す", async () => {
    const dir = makeWorktree(true);
    try {
      const verdict = await verifyContract(dir, {
        acceptanceReport: REPORT,
        resolveAugurCli: () => "augur.mjs",
        augurRunner: runner([
          { criterion: "C4-1 …", met: true },
          { criterion: "C4-2 …", met: true },
        ]),
      });
      expect(verdict.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("run.created_at を Augur --since の起点にそのまま使う", async () => {
    const dir = makeWorktree(true);
    try {
      let since = "";
      const verdict = await verifyContract(dir, {
        acceptanceReport: REPORT,
        resolveAugurCli: () => "augur.mjs",
        augurRunner: async ({ args }) => {
          since = args[args.indexOf("--since") + 1] ?? "";
          return JSON.stringify([
            { criterion: "C4-1 …", met: true },
            { criterion: "C4-2 …", met: true },
          ]);
        },
      });
      expect(verdict.ok).toBe(true);
      expect(since).toBe("2026-09-05T00:00:00.000Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("食い違う項目は unmet acceptance として completed を拒否する", async () => {
    const dir = makeWorktree(true);
    try {
      const verdict = await verifyContract(dir, {
        acceptanceReport: REPORT,
        resolveAugurCli: () => "augur.mjs",
        augurRunner: runner([
          { criterion: "C4-1 …", met: true },
          { criterion: "C4-2 …", met: false },
        ]),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toContain("unmet acceptance: C4-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("branchless run の merged-PR fallback より先に契約不一致を返す", async () => {
    const dir = makeWorktree(true);
    mkdirSync(join(dir, ".git"));
    try {
      const verdict = await verifyCompletionEvidence({ ...run, spawn_cwd: dir, spawn_branch: null }, {
        acceptanceReport: REPORT,
        resolveAugurCli: () => "augur.mjs",
        augurRunner: runner([
          { criterion: "C4-1 …", met: true },
          { criterion: "C4-2 …", met: false },
        ]),
      });
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toContain("unmet acceptance: C4-2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
