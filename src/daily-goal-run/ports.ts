/**
 * daily-goal-run の use case が要求する小さな port。
 *
 * @implements spec/feature/daily-goal-run.md — 状態の所有者 (判定 = headless 実行 / 記載 = Memoria)
 *
 * 実装 (DB・Claude CLI・Memoria・Actio・git) は composition root が組み立てる。
 * 他ドメインの状態はここを通してだけ読み、 DB 行を直接更新しない。 セッションは起動しない。
 */

import type { DailyGoalConfig } from "./config.js";
import type { EvidencePort } from "./evidence.js";
import type { GoalExtractionPort } from "./goal-extraction.js";
import type { MemoriaJournalPort } from "./memoria-journal.js";
import type { ProgressJudgePort } from "./progress-judge.js";

export interface DailyGoalProjectPort {
  /** プロジェクト名またはコードから登録済みの repo を引く。 一意に決まらなければ null。 */
  resolve(projectOrCode: string): { project: string; repoPath: string } | null;
}

export interface DailyGoalLog { info(message: string): void; warn(message: string): void }

export interface DailyGoalServiceDeps {
  repo: import("./repository.js").DailyGoalRepository;
  drafts: import("./draft-repository.js").DailyGoalDraftRepository;
  days: import("./day-repository.js").DailyGoalDayRepository;
  alerts: import("./alert-repository.js").DailyGoalAlertRepository;
  /** 投稿の読み取り (構造化した書式でない投稿だけに使う)。 */
  extraction: GoalExtractionPort;
  /** 1 時間ごとのワンショット判定 (セッションを残さない)。 */
  judge: ProgressJudgePort;
  /** 日のまとめの記載先 (Memoria の日記とノート)。 */
  journal: MemoriaJournalPort;
  evidence: EvidencePort;
  projects: DailyGoalProjectPort;
  config: () => DailyGoalConfig;
  newId?: () => string;
  log?: DailyGoalLog;
}
