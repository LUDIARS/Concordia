/**
 * 確認フローの状態機械。
 *
 *   pending --start--> confirming --ok--> confirmed
 *                          |  \--ng--> pending (main に戻す)
 *                          \--(起動失敗)--> failed (自動で main に戻す)
 *
 * 起動は必ず Excubitor 経由。 main 版と develop 版は同一ポートなので **同時に起動しない** —
 * 必ず「片方を stop してから もう片方を start」する。
 *
 * spec/feature/develop-confirm-flow.md §6-7。
 */

import type { ConfirmRunRow, ConfirmRunsRepo } from "../db/confirm-runs-repo.js";
import type { ExcubitorClient } from "../excubitor/client.js";
import { developServiceCode } from "../excubitor/client.js";
import type { MemoriaClient } from "../memoria/client.js";
import { buildClone } from "./build.js";
import { resolveClonePaths } from "./clone-paths.js";
import { promoteDevelopToMain, syncDevelopClone, syncMainClone } from "./git-ops.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("release/confirm");

/** develop 起動後、 liveness が立つのを待つ (プローブ間隔ぶん遅れて反映されるため)。 */
const LIVENESS_TRIES = 10;
const LIVENESS_INTERVAL_MS = 3_000;

export interface ConfirmServiceDeps {
  repo: ConfirmRunsRepo;
  excubitor: ExcubitorClient;
  memoria?: MemoriaClient;
  resolveWorkspaceRoots: () => string[];
  /** テスト用の待機差し替え。 */
  sleep?: (ms: number) => Promise<void>;
}

export interface ConfirmActionResult {
  ok: boolean;
  /** 人間に返す 1 行サマリ (Discord にそのまま出す)。 */
  message: string;
  runs: ConfirmRunRow[];
}

export class ConfirmService {
  constructor(private readonly deps: ConfirmServiceDeps) {}

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? ((d: number) => new Promise((r) => setTimeout(r, d))))(ms);
  }

  /**
   * 確認開始: develop クローンを同期 → ビルド → main 版を止めて develop 版を起動。
   * 起動できなければ自動で main 版に戻す (= 「機能追加によるダウン」への唯一の自動対応)。
   */
  async start(serviceCode: string, approvedBy: string): Promise<ConfirmActionResult> {
    const runs = this.deps.repo.listOpenForService(serviceCode);
    if (runs.length === 0) {
      return { ok: false, message: `確認待ちの変更がありません (${serviceCode})`, runs: [] };
    }

    const repoName = runs[0].repo_name;
    const paths = resolveClonePaths(repoName, this.deps.resolveWorkspaceRoots());
    if (!paths.develop) {
      return {
        ok: false,
        message: `develop クローンが見つかりません (${repoName})。 tools/ensure-develop-clones.mjs --apply で用意してください`,
        runs,
      };
    }

    const synced = await syncDevelopClone(paths.develop);
    if (!synced.ok) return this.fail(runs, `develop 同期に失敗: ${synced.error}`);
    const developSha = synced.stdout;
    for (const run of runs) {
      this.deps.repo.setDevelopSha(run.id, developSha);
      this.deps.repo.setStartApproval(run.id, approvedBy);
    }

    const built = await buildClone(paths.develop);
    if (!built.ok) return this.retryableFailure(runs, `ビルドに失敗: ${built.error}`);

    // 排他切替: main を止めてから develop を起動する。
    await this.deps.excubitor.control(serviceCode, "stop");
    const started = await this.deps.excubitor.control(developServiceCode(serviceCode), "start");
    if (!started.ok) {
      await this.rollbackToMain(serviceCode);
      return this.fail(runs, `develop 版の起動に失敗しました (main 版に戻しました): ${started.stderr?.slice(0, 300) ?? "起動エラー"}`);
    }

    const alive = await this.waitForLiveness(developServiceCode(serviceCode));
    if (alive === false) {
      await this.rollbackToMain(serviceCode);
      return this.fail(runs, "develop 版が起動しませんでした (main 版に戻しました)");
    }

    for (const run of runs) this.deps.repo.setStatus(run.id, "confirming", null);
    log.info({ service: serviceCode, runs: runs.length, develop_sha: developSha }, "confirm started");
    return {
      ok: true,
      message:
        `${serviceCode} を develop 版で起動しました (${runs.length} 件の変更 / ${developSha.slice(0, 7)})` +
        `${built.ran ? "" : " ※ビルド不要のリポのためビルドはスキップ"}\n` +
        `確認できたら \`/confirm ok ${serviceCode}\`、 やめるなら \`/confirm ng ${serviceCode}\``,
      runs: this.deps.repo.listOpenForService(serviceCode),
    };
  }

  /** 確認 OK: develop を main に ff 反映 → main 版で起動し直す → 確認タスクを done に。 */
  async ok(serviceCode: string, approvedBy: string): Promise<ConfirmActionResult> {
    const runs = this.deps.repo.listOpenForService(serviceCode).filter((r) => r.status === "confirming");
    if (runs.length === 0) {
      return { ok: false, message: `確認中の変更がありません (${serviceCode})。 先に /confirm start してください`, runs: [] };
    }
    const firstApprovers = new Set(runs.map((run) => run.start_approved_by).filter(Boolean));
    if (firstApprovers.size !== 1 || firstApprovers.has(approvedBy)) {
      return {
        ok: false,
        message: "main 反映には、確認開始者とは別 principal の承認が必要です",
        runs,
      };
    }
    const approvedShas = new Set(runs.map((run) => run.develop_sha).filter(Boolean));
    if (approvedShas.size !== 1) {
      return this.fail(runs, "確認対象の exact develop SHA を一意に確定できません");
    }
    const approvedSha = [...approvedShas][0]!;

    const paths = resolveClonePaths(runs[0].repo_name, this.deps.resolveWorkspaceRoots());
    const gitCwd = paths.develop ?? paths.main;
    if (!gitCwd) return this.fail(runs, `クローンが見つかりません (${runs[0].repo_name})`);

    const promoted = await promoteDevelopToMain(gitCwd, approvedSha);
    if (!promoted.ok) return this.fail(runs, `main 反映に失敗: ${promoted.error}`);

    // main 版で起動し直す (develop 版は止める)。 main クローンの同期に失敗しても
    // 起動自体は行い、 その旨を人間に伝える (黙って古い main を動かさない)。
    let warn = "";
    if (paths.main) {
      const mainSync = await syncMainClone(paths.main);
      if (!mainSync.ok) warn = `\n⚠️ main クローンの同期は見送りました: ${mainSync.error}`;
    }
    await this.deps.excubitor.control(developServiceCode(serviceCode), "stop");
    const started = await this.deps.excubitor.control(serviceCode, "start");
    if (!started.ok) {
      return this.fail(runs, `main 反映は済みましたが main 版の起動に失敗しました: ${started.stderr?.slice(0, 300) ?? "起動エラー"}`);
    }

    for (const run of runs) {
      this.deps.repo.setPromotionApproval(run.id, approvedBy);
      this.deps.repo.setStatus(run.id, "confirmed", null);
      await this.completeMemoriaTask(run);
    }
    log.info({ service: serviceCode, runs: runs.length, main_sha: promoted.stdout }, "confirm ok → main");
    return {
      ok: true,
      message: `${serviceCode}: develop を main に反映し、 main 版で起動しました (${runs.length} 件の確認を完了)${warn}`,
      runs: [],
    };
  }

  /** 確認中止: main 版に戻し、 確認は pending へ戻す (やり直せる)。 */
  async ng(serviceCode: string, reason?: string): Promise<ConfirmActionResult> {
    const runs = this.deps.repo.listOpenForService(serviceCode).filter((r) => r.status === "confirming");
    if (runs.length === 0) {
      return { ok: false, message: `確認中の変更がありません (${serviceCode})`, runs: [] };
    }
    await this.rollbackToMain(serviceCode);
    for (const run of runs) this.deps.repo.setStatus(run.id, "pending", reason ?? "確認中止");
    return {
      ok: true,
      message: `${serviceCode}: main 版に戻しました。 確認は待ち状態に戻しています${reason ? ` (理由: ${reason})` : ""}`,
      runs: this.deps.repo.listOpenForService(serviceCode),
    };
  }

  list(): ConfirmRunRow[] {
    return this.deps.repo.listOpen();
  }

  /** develop 版を止めて main 版を起動する (切り戻し)。 */
  private async rollbackToMain(serviceCode: string): Promise<void> {
    await this.deps.excubitor.control(developServiceCode(serviceCode), "stop");
    const started = await this.deps.excubitor.control(serviceCode, "start");
    if (!started.ok) {
      log.warn({ service: serviceCode }, "main 版への切り戻しに失敗した (手動で起動が要る)");
    }
  }

  /** liveness が立つまで待つ。 true=生存 / false=死亡確定 / null=判定不能 (プローブ履歴が無い)。 */
  private async waitForLiveness(code: string): Promise<boolean | null> {
    let last: boolean | null = null;
    for (let i = 0; i < LIVENESS_TRIES; i += 1) {
      await this.sleep(LIVENESS_INTERVAL_MS);
      last = await this.deps.excubitor.isAlive(code).catch(() => null);
      if (last === true) return true;
    }
    // 履歴が一度も付かない (= プローブ対象外のサービス) 場合は死亡と断定しない。
    return last;
  }

  private async completeMemoriaTask(run: ConfirmRunRow): Promise<void> {
    if (!run.memoria_task_id || !this.deps.memoria) return;
    try {
      await this.deps.memoria.completeTask(run.memoria_task_id);
    } catch (e) {
      // Memoria が落ちていても確認自体は成立している。 記録だけ残して続行する。
      log.warn({ task_id: run.memoria_task_id, err: (e as Error).message }, "確認タスクの done 化に失敗");
    }
  }

  private fail(runs: ConfirmRunRow[], message: string): ConfirmActionResult {
    for (const run of runs) this.deps.repo.setStatus(run.id, "failed", message);
    log.warn({ runs: runs.length, message }, "confirm failed");
    return { ok: false, message: `⚠️ ${message}`, runs };
  }

  /** サービス切替前の失敗は pending を保ち、原因を残したまま再試行可能にする。 */
  private retryableFailure(runs: ConfirmRunRow[], message: string): ConfirmActionResult {
    for (const run of runs) this.deps.repo.setStatus(run.id, "pending", message);
    log.warn({ runs: runs.length, message }, "confirm attempt failed; retry remains pending");
    return { ok: false, message: `⚠️ ${message}`, runs };
  }
}
