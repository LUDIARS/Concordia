/**
 * Revisor の候補一覧と Test Forum の投稿を突き合わせる純粋な同期ロジック。
 * @implements spec/feature/revisor-test-forum-sync.md — Source and lifecycle
 */
import { createHash } from "node:crypto";
import type { DiscordTestSurfaceRow, DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type {
  RevisorLocalPrDetail,
  RevisorTestWorkflowProduct,
} from "../pr/revisor-test-workflow-client.js";

export interface TestForumCandidate {
  repoOrigin: string;
  prNumber: number;
  pullRequestId: string;
  title: string;
  url: string | null;
  headBranch: string;
  headSha: string;
  repoRootPath: string;
  worktreePath: string | null;
  /** Revisor local PR の詳細・判断事項。 取得失敗時は null (骨格情報だけで掲載する)。 */
  detail: RevisorLocalPrDetail | null;
  /** 描画元データの指紋。 一致する限り Discord へ編集を投げない。 */
  contentHash: string;
}

export interface TestForumSurfaceAdapter {
  create(candidate: TestForumCandidate): Promise<{ threadId: string }>;
  /** 内容が変わった投稿を、 作り直さずスターターメッセージの編集でリフレッシュする。 */
  update(surface: DiscordTestSurfaceRow, candidate: TestForumCandidate): Promise<void>;
  /** DB id を customId に埋めるため、作成後に操作面を追加する。 */
  render?(surface: DiscordTestSurfaceRow): Promise<{ controlsMessageId: string }>;
  close(surface: DiscordTestSurfaceRow, reason: TestSurfaceCloseReason): Promise<void>;
}

/**
 * head-updated / worktree-removed は投稿を閉じる理由ではなくなった (編集で
 * リフレッシュする)。 型には旧 DB 行の close_reason として残る。
 */
export type TestSurfaceCloseReason =
  | "candidate-unavailable"
  | "head-updated"
  | "spawn-target-updated";

/**
 * 投稿ごとのテスト・QA セッションのライフサイクル。 start は delegation run id を
 * 返す (起動失敗は null — 投稿の掲載自体は止めない)。 end は投稿を閉じるとき
 * (マージ・取り下げ・再審査落ち) に関連セッションを畳む。
 */
export interface TestForumQaHooks {
  start(candidate: TestForumCandidate, threadId: string): Promise<string | null>;
  end(surface: DiscordTestSurfaceRow): Promise<void>;
}

export interface TestForumReconcileResult {
  scanned: number;
  kept: number;
  updated: number;
  created: number;
  closed: number;
  /** Discord 操作に失敗して今周期は見送った投稿の数 (DB は書き戻さないので次周期で再試行)。 */
  failed: number;
}

export function buildTestForumCandidates(
  products: readonly RevisorTestWorkflowProduct[],
  details: ReadonlyMap<string, RevisorLocalPrDetail> = new Map(),
): TestForumCandidate[] {
  return products.map((product) => {
    const detail = details.get(product.pullRequestId) ?? null;
    return {
      repoOrigin: product.repository,
      prNumber: product.number,
      pullRequestId: product.pullRequestId,
      title: product.title,
      url: null,
      headBranch: product.headRef,
      headSha: product.reviewedHeadSha,
      repoRootPath: product.repositoryRootPath,
      worktreePath: null,
      detail,
      contentHash: contentHashOf(product, detail),
    };
  });
}

/**
 * 描画に使うデータ全体の指紋。 描画関数は決定的なので、 これが一致する限り
 * 投稿の見た目も変わらない = Discord へ edit を投げない。
 */
function contentHashOf(
  product: RevisorTestWorkflowProduct,
  detail: RevisorLocalPrDetail | null,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      title: product.title,
      headSha: product.reviewedHeadSha,
      detail,
    }))
    .digest("hex");
}

function prKey(origin: string, number: number): string {
  return `${origin.toLowerCase()}#${number}`;
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function hasChangedSpawnTarget(
  surface: DiscordTestSurfaceRow,
  candidate: TestForumCandidate,
): boolean {
  return (
    !surface.repo_root_path
    || !surface.head_branch
    || normalizedPath(surface.repo_root_path) !== normalizedPath(candidate.repoRootPath)
    || surface.head_branch !== candidate.headBranch
  );
}

export async function reconcileTestForum(input: {
  candidates: readonly TestForumCandidate[];
  surfaces: DiscordTestSurfacesRepo;
  adapter: TestForumSurfaceAdapter;
  qa?: TestForumQaHooks;
  log?: { warn(message: string): void };
}): Promise<TestForumReconcileResult> {
  const candidatesByPr = new Map(input.candidates.map((candidate) => [
    prKey(candidate.repoOrigin, candidate.prNumber),
    candidate,
  ]));
  const existing = input.surfaces.listOpen();
  const keptKeys = new Set<string>();
  let closed = 0;
  let updated = 0;
  let failed = 0;

  // 1 投稿の Discord 失敗 (archive / 権限 / rate limit) で同期全体を止めない。
  // 失敗した投稿は DB を書き戻さないので、 次周期に同じ処理をやり直す。
  const isolate = async (label: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      failed += 1;
      input.log?.warn(`test-forum surface ${label} failed: ${(error as Error).message}`);
    }
  };

  for (const surface of existing) {
    const key = prKey(surface.repo_origin, surface.pr_number);
    const candidate = candidatesByPr.get(key);
    if (!candidate) {
      // マージ・取り下げ・再審査落ちで候補から消えた。 投稿を閉じ、 関連する
      // テスト・QA セッションも一緒に終わらせる (end-session で先に閉じていれば no-op)。
      await isolate(key, async () => {
        await input.adapter.close(surface, "candidate-unavailable");
        if (input.qa) await input.qa.end(surface);
        input.surfaces.close(surface.id, "candidate-unavailable");
        closed += 1;
      });
      continue;
    }
    if (hasChangedSpawnTarget(surface, candidate)) {
      await isolate(key, async () => {
        await input.adapter.close(surface, "spawn-target-updated");
        if (input.qa) await input.qa.end(surface);
        input.surfaces.close(surface.id, "spawn-target-updated");
        closed += 1;
      });
      continue;
    }
    // 更新に失敗しても投稿は生きている扱いにする (kept に入れないと下の作成ループが
    // 同じ PR の投稿を二重に立ててしまう)。
    keptKeys.add(key);
    // 操作面の導入前に立った投稿 (controls_message_id 未設定) には、 head が変わるまで
    // 操作が一切出ない。 保持する候補にも遅れて操作面を足す。
    if (!surface.controls_message_id && input.adapter.render) {
      await isolate(`${key}:controls`, async () => {
        const rendered = await input.adapter.render!(surface);
        input.surfaces.setControlsMessageId(surface.id, rendered.controlsMessageId);
      });
    }
    if (surface.content_hash !== candidate.contentHash) {
      // head 前進や判断事項の変化は投稿の作り直しではなく編集で反映する。
      await isolate(key, async () => {
        await input.adapter.update(surface, candidate);
        input.surfaces.updateContent(surface.id, {
          headSha: candidate.headSha,
          contentHash: candidate.contentHash,
        });
        updated += 1;
      });
    }
  }

  let created = 0;
  for (const candidate of input.candidates) {
    const key = prKey(candidate.repoOrigin, candidate.prNumber);
    if (keptKeys.has(key)) continue;
    await isolate(key, async () => {
      const createdSurface = await input.adapter.create(candidate);
      const row = input.surfaces.create({
        repoOrigin: candidate.repoOrigin,
        prNumber: candidate.prNumber,
        headSha: candidate.headSha,
        repoRootPath: candidate.repoRootPath,
        headBranch: candidate.headBranch,
        worktreePath: candidate.worktreePath,
        threadId: createdSurface.threadId,
        contentHash: candidate.contentHash,
      });
      created += 1;
      if (input.qa) {
        // 投稿の検知 = テスト・QA セッションの起動点。 起動失敗は投稿の掲載を
        // 巻き戻さない (掲載が主・QA は従)。
        const qaRunId = await input.qa.start(candidate, createdSurface.threadId);
        if (qaRunId) input.surfaces.setQaRun(row.id, qaRunId);
      }
      // 操作面の描画は独立して隔離する。 ここで投げると QA 起動まで巻き添えで
      // 飛ぶが、 次周期の候補は「保持」側に回るので二度と起動されない。
      // 失敗しても投稿は残り、 次周期の backfill が操作面を貼り直す。
      if (input.adapter.render) {
        await isolate(`${key}:controls`, async () => {
          const rendered = await input.adapter.render!(row);
          input.surfaces.setControlsMessageId(row.id, rendered.controlsMessageId);
        });
      }
    });
  }

  return { scanned: existing.length, kept: keptKeys.size, updated, created, closed, failed };
}
