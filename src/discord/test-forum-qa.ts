/**
 * Test Forum 投稿ごとのテスト・QA セッション (delegation `test-qa`) の起動と後始末。
 * @implements spec/feature/revisor-test-forum-sync.md — テスト・QA delegation
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { callConcordia } from "./commands/_util.js";
import type { TestForumCandidate, TestForumQaHooks } from "./test-forum-reconcile.js";

const TEST_QA_CALL_NAME = "test-qa";

export interface TestForumQaDeps {
  concordiaUrl: string;
  /** ローカルクローンの親候補。 repository 名から対象リポの絶対パスを引く。 */
  workspaceRoots: readonly string[];
  subsidiaryId?: string | null;
  log: { info(message: string): void; warn(message: string): void };
}

// repository 名はそのまま cwd の一部になるので、 単純なリポ名だけを受け付ける。
// `org/..` のような値でワークスペース外 (親ディレクトリ等) を cwd にさせない。
const REPO_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** `org/name` の name をワークスペースルート群から探す。 見つからなければ null。 */
export function resolveCandidateRepoPath(
  roots: readonly string[],
  repoOrigin: string,
): string | null {
  const name = repoOrigin.split("/").pop();
  if (!name || name === "." || name === ".." || !REPO_NAME_RE.test(name)) return null;
  for (const root of roots) {
    const path = join(root, name);
    if (existsSync(path)) return path;
  }
  return null;
}

function detailSummary(candidate: TestForumCandidate): string {
  const detail = candidate.detail;
  if (!detail) return "";
  const lines: string[] = [];
  if (detail.decisionLabel) lines.push(`判定: ${detail.decisionLabel}`);
  if (detail.riskScore !== null) lines.push(`マージリスク: ${detail.riskScore}`);
  if (detail.runtimeVerificationRequired) lines.push("人間による動作確認が必要と判定されている");
  for (const blocker of detail.blockers.slice(0, 5)) lines.push(`判断事項: ${blocker}`);
  return lines.join("\n");
}

/**
 * Test Forum 投稿ごとのテスト・QA セッションの起動と後始末。
 *
 * - start: 投稿の検知で delegation `test-qa` を spawn し、 run id を返す。
 * - end: 投稿を閉じるとき (マージ等)、 run の child session を end-session する。
 *   end-session で先に終わっていれば DELETE は失敗するが、 それは正常系として扱う。
 */
export function createTestForumQaHooks(deps: TestForumQaDeps): TestForumQaHooks {
  return {
    async start(candidate, threadId) {
      const targetRepo = resolveCandidateRepoPath(deps.workspaceRoots, candidate.repoOrigin);
      const result = await callConcordia<{
        ok: boolean;
        run: { id: string };
      }>(deps.concordiaUrl, "POST", "/v1/delegation/invoke", {
        call_name: TEST_QA_CALL_NAME,
        args: {
          repository: candidate.repoOrigin,
          pr_number: String(candidate.prNumber),
          pr_title: candidate.title,
          thread_id: threadId,
          ...(targetRepo ? { target_repo: targetRepo } : {}),
          details: detailSummary(candidate),
        },
        ...(deps.workspaceRoots[0] ? { cwd: deps.workspaceRoots[0] } : {}),
        triggered_by: `test-forum:${candidate.repoOrigin}#${candidate.prNumber}`,
        spawn: true,
        subsidiary_id: deps.subsidiaryId ?? null,
      });
      if ("error" in result || !result.ok) {
        const error = "error" in result ? result.error : "delegation invoke failed";
        deps.log.warn(
          `test-forum QA spawn failed ${candidate.repoOrigin}#${candidate.prNumber}: ${error}`,
        );
        return null;
      }
      deps.log.info(
        `test-forum QA spawned ${candidate.repoOrigin}#${candidate.prNumber} run=${result.run.id}`,
      );
      return result.run.id;
    },
    async end(surface) {
      if (!surface.qa_run_id) return;
      const run = await callConcordia<{
        run?: { child_session_id?: string | null };
      }>(deps.concordiaUrl, "GET", `/v1/delegation/runs/${encodeURIComponent(surface.qa_run_id)}`);
      if ("error" in run) {
        deps.log.warn(`test-forum QA run lookup failed run=${surface.qa_run_id}: ${run.error}`);
        return;
      }
      const sessionId = run.run?.child_session_id;
      if (!sessionId) return;
      const ended = await callConcordia<{ ok: boolean }>(
        deps.concordiaUrl,
        "DELETE",
        `/v1/sessions/${encodeURIComponent(sessionId)}`,
      );
      if ("error" in ended) {
        // 既に end-session 済み / セッション消滅は正常系。 記録だけ残す。
        deps.log.info(
          `test-forum QA session end skipped session=${sessionId}: ${ended.error}`,
        );
        return;
      }
      deps.log.info(`test-forum QA session ended session=${sessionId} (surface ${surface.repo_origin}#${surface.pr_number})`);
    },
  };
}
