/**
 * ConversationService の外部 I/O を Concordia の既存部品へ接続する (adapter)。
 *
 * - 保留条件の事実: 未回答質問 (discord_pending_questions)、未終了の子 run、draft/open の PR
 * - 配達: 既存の session.inject と同じイベント (人間入力は discord:<user>:<thread>:<message> の出所を保つ)
 * - 後継の起動: 同じ Astra With Sidecar テンプレートを、元の Session forum スレッドの
 *   trigger で起動する (session.started 時に同じスレッドへ結び付く)。 Actio は既存の
 *   task 参照を続けるので新しい task を封印しない。
 * - 旧担当の終了: 発話による終了要求と同じ印を付け、ターンが静かになってから終わらせる。
 *
 * @implements spec/feature/astra-with-sidecar.md §会話と実行の寿命
 */

import type { DelegationRepo, DelegationRunRow } from "../../db/delegation-repo.js";
import type { DiscordPendingQuestionsRepo } from "../../db/discord-repo.js";
import type { PrRecordsRepo } from "../../db/pr-records-repo.js";
import type { SessionsRepo } from "../../db/sessions-repo.js";
import type { DelegationService } from "../../delegation/service.js";
import { ASTRA_WITH_SIDECAR_CALL_NAME, isSidecarParentMetadata } from "../../delegation/sidecar/profile.js";
import { markEndSessionRequested } from "../../shared/end-session-request.js";
import { eventBus } from "../../events.js";
import type { HandoffPackage } from "./handoff-package.js";
import type { ConversationRepo, ConversationHandoffRow } from "./repo.js";
import type { ConversationServicePorts } from "./service.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "spawn_failed"]);

export function createConversationServicePorts(deps: {
  conversations: ConversationRepo;
  sessions: SessionsRepo;
  delegation: DelegationRepo;
  delegationService: Pick<DelegationService, "invoke">;
  pendingQuestions: Pick<DiscordPendingQuestionsRepo, "listUnanswered">;
  prs: Pick<PrRecordsRepo, "list">;
  /** Session forum スレッドの起動 trigger (discord 側の書式を持ち込まないため注入)。 */
  buildThreadTrigger: (guildId: string, threadId: string) => string;
  now?: () => number;
}): ConversationServicePorts {
  const now = deps.now ?? (() => Date.now());
  const triggerFor = (handoff: ConversationHandoffRow): string | null => {
    const conversation = deps.conversations.findConversation(handoff.conversation_id);
    return conversation ? deps.buildThreadTrigger(conversation.guild_id, conversation.thread_id) : null;
  };
  return {
    repo: deps.conversations,
    now,
    isSidecarParent: (sessionId) => isSidecarParentMetadata(deps.sessions.findSession(sessionId)?.metadata ?? null),
    sessionActive: (sessionId) => {
      const session = deps.sessions.findSession(sessionId);
      return session ? session.status === "active" : null;
    },
    blockerFacts: ({ sessionId }) => {
      const session = deps.sessions.findSession(sessionId);
      return {
        ownerUnknown: session?.status !== "active",
        unansweredQuestions: deps.pendingQuestions.listUnanswered(sessionId).length,
        unfinishedChildRuns: deps.delegation.listRunsByParentSession(sessionId, 200)
          .filter((run) => !TERMINAL_RUN_STATUSES.has(run.status)).length,
        openPullRequests: deps.prs.list({ author_session_id: sessionId, states: ["draft", "open"], limit: 50 }).length,
      };
    },
    deliver: async ({ sessionId, text, source, authorLabel }) => {
      const session = deps.sessions.findSession(sessionId);
      if (!session || session.status !== "active") return "failed";
      const ts = Math.floor(now() / 1000);
      deps.sessions.appendEvent({ session_id: sessionId, ts, kind: "inject", payload: { text, source } });
      eventBus.emit({ type: "session.inject", target_session_id: sessionId, text, source, author_label: authorLabel, ts });
      return "delivered";
    },
    startSuccessor: async ({ handoff, conversation, brief }) => {
      const pkg = JSON.parse(handoff.package_json ?? "null") as HandoffPackage | null;
      const reference = pkg?.task_references.find((ref) => ref.startsWith("actio:"));
      if (!pkg || !reference) return { ok: false, error: "actio_task_reference_required" };
      const result = await deps.delegationService.invoke({
        call_name: ASTRA_WITH_SIDECAR_CALL_NAME,
        args: { task: brief, target_repo: pkg.repo_path, taskflow_reference: reference },
        cwd: pkg.repo_path,
        branch: pkg.branch,
        worktree: true,
        task_binding: "caller",
        triggered_by: deps.buildThreadTrigger(conversation.guild_id, conversation.thread_id),
        spawn: true,
        parent_session_id: null,
        subsidiary_id: conversation.scope || null,
        source_discord_guild_id: conversation.guild_id,
        source_discord_channel_id: conversation.thread_id,
      });
      if (!result.ok) return { ok: false, error: result.error };
      if (result.run.status === "spawn_failed") return { ok: false, error: result.run.error ?? "spawn_failed" };
      return { ok: true, runId: result.run.id };
    },
    findSuccessorRun: (handoff) => {
      let run: DelegationRunRow | null = handoff.successor_run_id ? deps.delegation.findRun(handoff.successor_run_id) : null;
      if (!run) {
        // 起動応答を失った場合: 同じスレッド trigger で、引継ぎ保存後に作られた run だけを照合する。
        const trigger = triggerFor(handoff);
        const candidate = trigger ? deps.delegation.findRunByTriggeredBy(trigger) : null;
        const since = handoff.package_saved_at ?? handoff.created_at;
        run = candidate && candidate.call_name === ASTRA_WITH_SIDECAR_CALL_NAME && candidate.created_at >= since ? candidate : null;
      }
      return run ? { runId: run.id, status: run.status, childSessionId: run.child_session_id } : null;
    },
    requestSessionEnd: (sessionId) => markEndSessionRequested(deps.sessions, sessionId),
  };
}
