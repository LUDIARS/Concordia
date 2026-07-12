/**
 * ブランチ切替の監視 (テスト交通整備のツール側シグナル)。
 *
 * プロンプトフックでの毎回注入は非効率なので、 セッション行の branch (Lictor が
 * 登録/heartbeat で更新する) の変化をポーリングで検知し、 変化したセッションにだけ
 * 「再起動・起動テストは Excubitor 経由 + 本体フォルダ / テスト前に一報」 の案内を
 * inject する。 テスト claim を宣言済みのセッションには出さない (既に一報済み)。
 * 通知はセッションごとに NOTIFY_COOLDOWN_MS で間引く (branch を頻繁に行き来する
 * 作業でスパムしない)。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { injectTestingNotice } from "./notify.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";

const POLL_MS = 30_000;
const NOTIFY_COOLDOWN_MS = 60 * 60 * 1000;

export interface BranchWatchDeps {
  sessions: SessionsRepo;
  claims: TestingClaimsRepo;
  log?: { info: (m: string) => void; warn: (m: string) => void };
  /** テスト差し替え用 (既定 injectTestingNotice)。 */
  notify?: (repo: SessionsRepo, sessionId: string, text: string) => void;
  intervalMs?: number;
}

export function guidanceText(prev: string, next: string, activeSummary: string): string {
  return [
    `⚠️ ブランチ切替を検知しました (${prev} → ${next})。`,
    "再起動・起動テストは Excubitor 経由でプロジェクト本体フォルダのみで行ってください (worktree / 複製フォルダからの起動は禁止)。",
    "サービスの再起動やテストを行う際は、事前に Concordia へ一報してください:",
    "  POST http://127.0.0.1:11111/v1/testing/claim {\"session_id\":\"<自分の session_id>\",\"service\":\"<サービスコード>\",\"note\":\"何をテストするか\"}",
    "  終わったら POST /v1/testing/release。 (/cc-test スキル参照)",
    activeSummary ? `現在テスト中: ${activeSummary}` : "現在テスト中のサービスはありません。",
  ].join("\n");
}

export function startBranchWatch(deps: BranchWatchDeps): { stop(): void } {
  const notify = deps.notify ?? injectTestingNotice;
  const lastBranch = new Map<string, string>();
  const lastNotifiedAt = new Map<string, number>();

  const tick = (): void => {
    let active: ReturnType<SessionsRepo["listSessions"]>;
    try {
      active = deps.sessions.listSessions({ status: "active" });
    } catch (e) {
      deps.log?.warn(`branch-watch list failed: ${(e as Error).message}`);
      return;
    }
    const seen = new Set<string>();
    const now = Date.now();
    for (const s of active) {
      seen.add(s.id);
      const branch = s.branch ?? "";
      const prev = lastBranch.get(s.id);
      lastBranch.set(s.id, branch);
      if (prev === undefined || prev === branch || !branch) continue; // 初観測 / 変化なし
      if (deps.claims.hasActiveClaim(s.id, Math.floor(now / 1000))) continue; // 一報済み
      const last = lastNotifiedAt.get(s.id) ?? 0;
      if (now - last < NOTIFY_COOLDOWN_MS) continue;
      lastNotifiedAt.set(s.id, now);
      const activeSummary = deps.claims
        .listActive(Math.floor(now / 1000))
        .map((cl) => `${cl.service} (${cl.session_id})`)
        .join(", ");
      try {
        notify(deps.sessions, s.id, guidanceText(prev || "(不明)", branch, activeSummary));
        deps.log?.info(`branch-watch notified session=${s.id} ${prev} -> ${branch}`);
      } catch (e) {
        deps.log?.warn(`branch-watch notify failed session=${s.id}: ${(e as Error).message}`);
      }
    }
    // 消えたセッションの追跡状態を掃除 (メモリリーク防止)。
    for (const id of [...lastBranch.keys()]) {
      if (!seen.has(id)) {
        lastBranch.delete(id);
        lastNotifiedAt.delete(id);
      }
    }
  };

  const supervised = startSupervisedInterval("branch-watch", tick, {
    intervalMs: deps.intervalMs ?? POLL_MS,
    log: { warn: (message) => deps.log?.warn(message) },
  });
  return {
    stop() {
      supervised.stop();
    },
  };
}
