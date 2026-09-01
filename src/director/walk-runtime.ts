/**
 * @implements spec/feature/curiosity-walk.md
 *
 * 散歩セッションの実行系。 ポアソン間隔 (walk-scheduler.ts) で発火し、 稼働中チーム
 * (本社 + 子会社所有) から 1 チームを引き、 関連の薄い 2 素材 (walk-materials.ts) を
 * 並べる読み取り専用セッションを delegation で起こす。 出力は「ぼやき」への 1 投稿だけ。
 *
 * 2026-09-01 neco 指示: チームの巡回由来の装置はこれだけを残す (Director 巡回の
 * 自動実装起動・朝礼/定例 fanout は休止)。 子会社所有チームにも同じ装置を適用する。
 */

import { createChildLogger } from "../shared/logger.js";
import { nextWalkDelayMs, type WalkScheduleOpts } from "./walk-scheduler.js";
import { sampleWalkPair, type WalkMaterial } from "./walk-materials.js";
import type { WalkRow } from "../db/walks-repo.js";

const log = createChildLogger("curiosity-walk");
const DEFAULT_CALL_NAME = "claude-sonnet-5-walk";
const RECENT_COMBO_WINDOW_MS = 7 * 24 * 3600_000;

export interface WalkTeamView {
  id: string;
  name: string;
  slug: string;
  subsidiary_id: string | null;
}

export interface CuriosityWalkDeps {
  teams: {
    listActive(): WalkTeamView[];
    repos(teamId: string): string[];
  };
  walks: {
    insert(input: Omit<WalkRow, "id" | "created_at">): WalkRow;
    setRunId(id: string, runId: string): void;
    recentComboKeys(sinceMs: number): Set<string>;
  };
  materials: () => Promise<WalkMaterial[]>;
  delegationService: {
    invoke(input: {
      call_name: string;
      args: Record<string, unknown>;
      cwd: string;
      triggered_by?: string;
      options?: Record<string, unknown>;
    }): Promise<{ ok: true; run: { id: string; status: string } } | { ok: false; error: string }>;
  };
  /** 散歩セッションを起動する既存の workspace directory。 */
  cwd: string;
  /** 既定 claude-sonnet-5-walk (env CONCORDIA_CURIOSITY_CALL_NAME で上書き)。 */
  callName?: string;
  scheduleOpts?: WalkScheduleOpts;
  rand?: () => number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

export interface CuriosityWalkHandle {
  stop: () => void;
  /** テスト・手動起動用。 1 回分の散歩を即時実行する。 */
  runOnce: () => Promise<void>;
}

export function startCuriosityWalk(deps: CuriosityWalkDeps): CuriosityWalkHandle {
  const callName = (deps.callName ?? process.env.CONCORDIA_CURIOSITY_CALL_NAME ?? DEFAULT_CALL_NAME).trim()
    || DEFAULT_CALL_NAME;
  const rand = deps.rand ?? Math.random;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return { clear: () => clearTimeout(t) };
  });

  let stopped = false;
  let timer: { clear: () => void } | null = null;

  async function fire(): Promise<void> {
    if (stopped) return;
    // チームは「稼働中 (suspended でない)」の本社 + 子会社所有すべてから 1 つ引く。
    // チームが無くても散歩自体は成立する (チーム未所属のグローバル散歩)。
    const teams = deps.teams.listActive();
    const team = teams.length > 0
      ? teams[Math.min(teams.length - 1, Math.floor(rand() * teams.length))]!
      : null;

    const materials = await deps.materials();
    // workflow OFF が素材収集中に入った場合、その tick から新しい run を起動しない。
    if (stopped) return;
    const pair = sampleWalkPair(materials, {
      biasRepos: team ? deps.teams.repos(team.id) : [],
      recentCombos: deps.walks.recentComboKeys(RECENT_COMBO_WINDOW_MS),
      rand,
    });
    if (!pair) {
      log.info("curiosity walk skipped: not enough distinct-repo materials");
      return;
    }

    const walk = deps.walks.insert({
      team_id: team?.id ?? null,
      subsidiary_id: team?.subsidiary_id ?? null,
      repo_a: pair.a.repo,
      repo_b: pair.b.repo,
      material_a: pair.a.label,
      material_b: pair.b.label,
      combo_key: pair.comboKey,
      run_id: null,
    });

    const result = await deps.delegationService.invoke({
      call_name: callName,
      cwd: deps.cwd,
      args: {
        walk_id: walk.id,
        material_a: `${pair.a.label} — ${pair.a.detail}`,
        material_b: `${pair.b.label} — ${pair.b.detail}`,
        team_label: team ? team.name : "",
      },
      triggered_by: `curiosity-walk:${walk.id}`,
      // 投稿先は本社「ぼやき」1 本なので session/run は本社帰属にする。選ばれた
      // チームとの対応は curiosity_walks.team_id/subsidiary_id が正本として保持する。
      options: { goal_and_go: false },
    });
    if (!result.ok) {
      log.warn({ walk_id: walk.id, callName }, `curiosity walk launch failed: ${result.error}`);
      return;
    }
    if (result.run.status === "spawn_failed") {
      // invoke は spawn 失敗も監査用 run として ok:true で返す。起動できなかった
      // 組み合わせを recent 扱いせず、成功ログも出さない。
      log.warn({ walk_id: walk.id, run: result.run.id, callName }, "curiosity walk spawn failed");
      return;
    }
    deps.walks.setRunId(walk.id, result.run.id);
    log.info(
      { walk_id: walk.id, run: result.run.id, team: team?.slug ?? null, combo: pair.comboKey },
      "curiosity walk launched",
    );
  }

  function scheduleNext(): void {
    if (stopped) return;
    const delayMs = nextWalkDelayMs(now(), rand, deps.scheduleOpts);
    timer = setTimer(() => {
      void fire()
        .catch((error) => log.warn(`curiosity walk tick failed: ${(error as Error).message}`))
        .finally(scheduleNext);
    }, delayMs);
    log.info({ next_in_min: Math.round(delayMs / 60000) }, "curiosity walk scheduled");
  }

  scheduleNext();
  return {
    stop: () => {
      stopped = true;
      timer?.clear();
      timer = null;
    },
    runOnce: () => fire(),
  };
}
