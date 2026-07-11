/**
 * develop へ入った変更を確認待ちとして受け付ける。
 *
 * PR reconciler (gh CLI ポーリング) が「base=develop の PR が merged」を観測するたびに呼ばれる。
 * 同じ merge を何度も観測するので **冪等** であること (行が既にあれば何もしない)。
 *
 * spec/feature/develop-confirm-flow.md §5。
 */

import type { ConfirmRunsRepo, ConfirmRunRow } from "../db/confirm-runs-repo.js";
import type { MemoriaClient } from "../memoria/client.js";
import { repoNameFromOrigin } from "./clone-paths.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("release/confirm-intake");

export interface DevelopMergeEvent {
  repo_origin: string;
  pr_number: number;
  pr_title: string;
  pr_url: string | null;
}

export interface ConfirmIntakeDeps {
  repo: ConfirmRunsRepo;
  memoria?: MemoriaClient;
  /** リポ名 → Excubitor のサービスコード。 起動を伴わないリポは null。 */
  resolveServiceCode: (repoName: string) => Promise<string | null>;
}

/**
 * develop マージ 1 件を確認待ちに積む。 新規に積んだときだけ Memoria に確認タスクを作る。
 * 戻り値は作成/既存の行 (既存なら created=false)。
 */
export async function intakeDevelopMerge(
  deps: ConfirmIntakeDeps,
  event: DevelopMergeEvent,
): Promise<{ row: ConfirmRunRow; created: boolean }> {
  const repoName = repoNameFromOrigin(event.repo_origin);
  const serviceCode = await deps.resolveServiceCode(repoName);

  const { row, created } = deps.repo.createIfAbsent({
    repo_origin: event.repo_origin,
    repo_name: repoName,
    service_code: serviceCode,
    pr_number: event.pr_number,
    pr_title: event.pr_title,
    pr_url: event.pr_url,
  });
  if (!created) return { row, created };

  log.info(
    { repo: event.repo_origin, pr: event.pr_number, service: serviceCode },
    "develop merge → 確認待ちに積んだ",
  );

  if (deps.memoria) {
    try {
      const task = await deps.memoria.createTask({
        title: `[確認] ${repoName} #${event.pr_number} ${event.pr_title}`.slice(0, 200),
        category: "確認タスク",
        details: buildTaskDetails(repoName, serviceCode, event),
      });
      deps.repo.setMemoriaTaskId(row.id, task.id);
    } catch (e) {
      // Memoria が落ちていても確認待ち自体は Concordia 側に残る (/confirm list で見える)。
      log.warn({ err: (e as Error).message }, "Memoria への確認タスク作成に失敗 (確認待ちは Cc 側に残る)");
    }
  }
  return { row: deps.repo.find(row.id) ?? row, created };
}

function buildTaskDetails(repoName: string, serviceCode: string | null, event: DevelopMergeEvent): string {
  const lines = [
    `${repoName} の develop に PR #${event.pr_number} がマージされました。 動作確認をお願いします。`,
    "",
    `- PR: ${event.pr_url ?? `#${event.pr_number}`}`,
    `- タイトル: ${event.pr_title}`,
  ];
  if (serviceCode) {
    lines.push(
      "",
      "## 確認手順 (Discord)",
      "",
      `1. \`/confirm start ${serviceCode}\` — develop 版に切り替えて起動する`,
      "2. 動作を確認する",
      `3. \`/confirm ok ${serviceCode}\` — main に反映して main 版で起動し直す`,
      `   (問題があれば \`/confirm ng ${serviceCode}\` で main 版に戻す)`,
    );
  } else {
    lines.push(
      "",
      "起動を伴わないリポなので、 内容を確認したら `/confirm ok` で main に反映してください。",
    );
  }
  return lines.join("\n");
}
