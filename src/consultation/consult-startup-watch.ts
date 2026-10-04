/**
 * 相談の claude が起動後に会話を始めないことの見張り (spec/feature/tech-consultation.md §6.3)。
 *
 * 2026-10-03、 相談専用の設定フォルダのログインが切れており (OAuth Error 400)、 相談の claude は起動直後のログイン画面で
 * 止まった。 Cc 上はセッションが active のまま、 transcript が作られず、 相談者には何も返らなかった。
 * ログイン情報の無効化はファイルからは分からない (consult-claude-login.ts) ので、 起動から一定時間たっても transcript が
 * 無い相談セッションを見つけたら、 運用者へ 1 度だけ知らせる (再ログインのコマンドを添える)。
 *
 * 判定は純関数 (consultStartupStalled)、 見回りは application (startConsultStartupWatch)、 投稿は呼び出し側の port。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import { startSupervisedInterval } from "../shared/loop-bulkhead.js";
import { isInConsultWorkspace } from "./projectless-consult.js";

const POLL_MS = 60_000;
/** 起動から transcript ができるまでの猶予。 初回指示の組み立てと Lictor の transcript 検出を待つ。 */
export const CONSULT_STARTUP_GRACE_SEC = 180;

export interface ConsultStartupInput {
  provider: string;
  repoPath: string;
  startedAtSec: number;
  transcriptPath: string | null;
  nowSec: number;
}

/** 相談用ディレクトリで起動した claude が、 猶予を過ぎても transcript を持たないか。 */
export function consultStartupStalled(input: ConsultStartupInput, consultRoot: string, graceSec = CONSULT_STARTUP_GRACE_SEC): boolean {
  return input.provider === "claude-code"
    && isInConsultWorkspace(input.repoPath, consultRoot)
    && !input.transcriptPath
    && input.nowSec - input.startedAtSec >= graceSec;
}

/** 運用者への知らせの本文。 相談の内容は含めない (セッション id と場所だけ)。 */
export function consultStartupStalledNotice(sessionId: string, repoPath: string, reloginCommand: string): string {
  return [
    `⚠️ 相談セッション ${sessionId} (${repoPath}) が起動から ${Math.round(CONSULT_STARTUP_GRACE_SEC / 60)} 分たっても会話を始めていません。`,
    "相談専用の Claude 設定フォルダのログインが切れている可能性があります (起動直後のログイン画面で止まる)。",
    `PowerShell で次を実行して /login し直し、止まった相談セッションを終了してから相談を起動し直してください: ${reloginCommand}`,
  ].join("\n");
}

export interface ConsultStartupWatchDeps {
  sessions: Pick<SessionsRepo, "listSessions">;
  consultRoot: string;
  reloginCommand: string;
  post: (text: string) => void;
  log?: { info: (m: string) => void; warn: (m: string) => void };
  intervalMs?: number;
  now?: () => number;
}

export function startConsultStartupWatch(deps: ConsultStartupWatchDeps): { stop(): void } {
  const notified = new Set<string>();
  const tick = (): void => {
    let active: ReturnType<SessionsRepo["listSessions"]>;
    try {
      active = deps.sessions.listSessions({ status: "active" });
    } catch (error) {
      deps.log?.warn(`consult-startup-watch list failed: ${(error as Error).message}`);
      return;
    }
    const nowSec = Math.floor((deps.now?.() ?? Date.now()) / 1000);
    const seen = new Set<string>();
    for (const session of active) {
      seen.add(session.id);
      if (notified.has(session.id)) continue;
      const stalled = consultStartupStalled({
        provider: session.provider, repoPath: session.repo_path, startedAtSec: session.started_at,
        transcriptPath: session.transcript_path, nowSec,
      }, deps.consultRoot);
      if (!stalled) continue;
      notified.add(session.id);
      try {
        deps.post(consultStartupStalledNotice(session.id, session.repo_path, deps.reloginCommand));
        deps.log?.warn(`consult-startup-watch notified session=${session.id}`);
      } catch (error) {
        deps.log?.warn(`consult-startup-watch post failed session=${session.id}: ${(error as Error).message}`);
      }
    }
    for (const id of [...notified]) if (!seen.has(id)) notified.delete(id);
  };
  const supervised = startSupervisedInterval("consult-startup-watch", tick, {
    intervalMs: deps.intervalMs ?? POLL_MS,
    log: { warn: (message) => deps.log?.warn(message) },
  });
  return { stop: () => supervised.stop() };
}
