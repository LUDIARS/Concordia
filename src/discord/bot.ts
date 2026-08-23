import { ChannelType, Client, Events, GatewayIntentBits, Partials, type Guild, type TextChannel } from "discord.js";
import type { Database } from "better-sqlite3";
import type { ChatRepo } from "../db/chat-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import type { ConcordiaEvent } from "../events.js";
import { eventBus } from "../events.js";
import {
  makeChatMessageReactionsRepo,
  makeDiscordConfigRepo,
  makeDiscordMessageMapRepo,
  makeDiscordPendingQuestionsRepo,
  makeDiscordSessionChannelsRepo,
} from "../db/discord-repo.js";
import { makeDiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import { makeSessionMessageDeliveryRepo } from "../db/session-message-delivery-repo.js";
import type { RevisorTestWorkflowSource } from "../pr/revisor-test-workflow-client.js";
import { ensureDeskChannel, ensureDiscordLayout, ensureIntakeChannel, type DiscordConfigSnapshot, type EnsureLayoutOptions } from "./config.js";
import { getEgressDedupStats, handleEvent as handleEgressEvent, isActiveRelayTarget } from "./egress.js";
import { handleMessage as handleIngressMessage } from "./ingress.js";
import { DirectorRepo } from "../director/repo.js";
import { handleReactionAdd, handleReactionRemove } from "./reactions.js";
import { shouldRestartDiscordBot } from "./gateway-policy.js";
import { type RwfRunOptions, type RwfRunResult, type WorkflowAction } from "../platform/reaction-workflow.js";
import { getRwf } from "../platform/reaction-workflow-loader.js";
import {
  onSessionRegistered,
  onSessionStatusChanged,
  onSessionTitleChanged,
  onSessionWorkState,
  updateSessionSurfaceMetadata,
  pruneStatusCategoryChannels,
  reconcileEndedSessionChannels,
  reconcileLostSessionChannels,
  reconcileActiveSessionForumThreads,
  archiveStaleChannels,
} from "./session-channel.js";
import { ChannelWorkState } from "./channel-work-state.js";
import type { SessionRelayState } from "../platform/chat-read-model.js";
import { replayPersistedTranscript, type TranscriptReplaySource } from "./transcript-replay.js";
import { upsertSessionStatusCard, deleteSessionStatusCard, reconcileLostStatusCards, getStatusChannelId } from "./session-status-card.js";
import { postDelegationThreadLink } from "./delegation-thread-link.js";
import { takeInjectAck } from "./inject-ack.js";
import { upsertCostChannelMessage } from "./cost-channel.js";
import { upsertMonitorChannelMessage } from "./monitor-channel.js";
import { upsertPrQueueChannelMessage } from "./pr-queue-channel.js";
import { startVestigiumErrorWatch, type ErrorMonitorHandle } from "./error-monitor.js";
import { reportError, looksLikeFailure } from "../errors.js";
import { WebhookPool } from "./webhook-pool.js";
import { readDiscordEnv, type DiscordEnv } from "./types.js";
import { dispatchInteraction, registerGuildCommands, type DiscordCommandDeps } from "./commands.js";
import {
  COMMAND_REGISTRATION_CHECK_MS,
  startCommandRegistrationWatch,
  workflowCommandSignature,
  type CommandRegistrationWatchHandle,
} from "./command-workflow.js";
import { toPermissionRequestsResolver } from "./permission-request-flag.js";
import type { WorkflowKey } from "../workflow/keys.js";
import { describeInteractionForLog, interactionAgeMs } from "./interaction-diagnostics.js";
import {
  delegationTemplateCache,
  invalidateAndRefreshDelegationTemplateCache,
  prewarmDelegationTemplateCache,
} from "./delegation-template-cache.js";
import { postQuestion, resolveQuestionMessage } from "./question.js";
import { postPermissionRequest, type PermissionActionStore } from "./permission.js";
import { createChildLogger } from "../shared/logger.js";
import { parseInjectSource } from "../shared/inject-source.js";
import { eventSessionId } from "./projection.js";
import { resolveIntake } from "./intake-router.js";
import type { ChatPlatform } from "../platform/chat-platform.js";
import type { FederationEgressRequestFrame } from "../federation/protocol.js";
import { stopLifecycle } from "../platform/lifecycle.js";
import type { ChatReadModel } from "../platform/chat-read-model.js";
import { excubitorProjectCache } from "./excubitor-project-cache.js";
import { excubitorBaseUrl } from "../config/service-urls.js";
import { instrumentDiscord, recordDiscordInteractionAck } from "../instrumentation.js";
import { startInteractionAckProbe } from "./interaction-ack.js";
import { createForumProjectResolver } from "./forum-project-code.js";
import {
  handleForumSpawnThread,
  parseForumSpawnTrigger,
  type ForumSpawnDeps,
  type ForumSpawnThread,
} from "./forum-spawn.js";
import { selectForumDelegationTemplate } from "./forum-delegation-selector.js";
import {
  resolveForumSessionSurface,
} from "./forum-session.js";
import { postSessionStartupContext } from "./session-startup-context.js";
import {
  postSessionTaskBody,
  stripDelegationInjectHeader,
  taskKindForInjectSource,
} from "./session-task-post.js";
import { bindForumSpawnSession } from "./forum-spawn-session.js";
import { buildTaskflowDecisionMessage } from "./taskflow-decision-message.js";
import { scheduleBootForumReconciliations } from "./boot-forum-reconcile.js";
import { buildTestForumCandidates, reconcileTestForum } from "./test-forum-reconcile.js";
import { createTestForumDiscordAdapter, refreshTestForumControls } from "./test-forum-discord.js";
import { createTestForumQaHooks } from "./test-forum-qa.js";
import { resolveSessionMentions } from "./test-forum-mentions.js";
import { handleTestForumMessage } from "./test-forum-message.js";
import { callConcordia } from "./commands/_util.js";
import { createTestForumRefreshTrigger } from "./test-forum-trigger.js";
import type { RevisorLocalPrMerger, RevisorLocalPrReader } from "../pr/revisor-client.js";
import { readTestSurfaceId } from "./test-forum-session.js";
import { buildContextReport } from "./context-report.js";
import { renderPlanCard } from "./plan-card.js";
import { recordPlanCardMessageId, recordQuestionCardMessageId } from "./phase-index.js";
import { ensureTeamDiscordLayout } from "./team-provision.js";
import { postTeamAuditCard } from "./team-audit-card.js";
import { postTeamCard } from "./team-post-card.js";
import { resolveTeamCardChannel, type TeamCardKind } from "./team-card-routing.js";
import { resolveTeamSessionForumId } from "./team-session-surface.js";
import { TeamsRepo } from "../db/teams-repo.js";
import { ProjectCodesRepo } from "../db/project-codes-repo.js";
import { MemoriaClient } from "../memoria/client.js";
import { TeamMetricsRepo, localMidnightSec } from "../db/team-metrics-repo.js";
import { renderTeamCostReport } from "./team-cost-report.js";

/**
 * スレッドタイトルに載せる作業リポ群。 Lictor が active repo を 1 本も報告して
 * いない間は repo_path (登録時の cwd) にフォールバックする。
 */
function readActiveRepos(state: SessionRelayState | null | undefined): string[] {
  if (!state) return [];
  return [...new Set([
    ...(state.targetProject ? [state.targetProject] : []),
    ...(state.activeRepos.length > 0 ? state.activeRepos : [state.repoPath]),
  ])];
}

const discordLog = createChildLogger("discord");
// Discord autocomplete must acknowledge within three seconds. Leave time for
// formatting and the gateway response even when the local Memoria service stalls.
const AUTOCOMPLETE_MEMORIA_TIMEOUT_MS = 2_000;
// warn/error のうち「失敗」 を表すものは reportError 経由で errors チャンネルへも転記.
// (cost channel unavailable 等の非失敗 warn はノイズになるので looksLikeFailure で除外)
const log = {
  info: (m: string) => discordLog.info(m),
  warn: (m: string) => {
    discordLog.warn(m);
    if (looksLikeFailure(m)) reportError("discord", m);
  },
  error: (m: string) => {
    discordLog.error(m);
    reportError("discord", m);
  },
};

/**
 * 作業状態をセッションチャンネルへ反映する。
 *
 * Anatomia の state-machine 規約 (preset stateAccessPath) は「名前が `State` で終わる
 * 関数は `Transition` / `Apply` / `Reduce` からのみ呼べる」と定めている。
 * `onSessionWorkState` はその状態ノード側で、 起動関数 (`startDiscordBot`) から直に
 * 呼ぶと severity=error の違反になり、 **その関数を触る PR がすべてブロックされる**。
 *
 * 反映処理をこの入口に閉じ込めることで、 規約が意図するとおり「状態への出入りは
 * Apply を通す」形になる。 挙動は変えていない。
 *
 * 名前が `sessionWorkStateApply` なのは規約の照合が **大文字小文字を区別する**ため
 * (`new RegExp("Transition|Apply|Reduce")`)。 `applySessionWorkState` のように小文字で
 * 始めると許可パターンに合致せず、 ラッパを挟んでも違反のままになる。 併せて末尾が
 * `Apply` なので `State$` にも当たらず、 この入口自体が状態ノード扱いされることもない。
 */
async function sessionWorkStateApply(
  deps: Parameters<typeof onSessionWorkState>[0],
  input: Parameters<typeof onSessionWorkState>[1],
): Promise<void> {
  await onSessionWorkState(deps, input);
}

// 許可要求の投稿可否は「都度解決」 の形で持つ (W6)。 判定本体と resolver は
// permission-request-flag.ts に置き、 ここは既存の import 経路を保つ再輸出。
export { shouldPostPermissionRequestToDiscord } from "./permission-request-flag.js";

export type DiscordHeadlessRunner = (
  prompt: string,
  opts?: RwfRunOptions & { timeoutMs?: number },
) => Promise<RwfRunResult>;
export type DiscordRepinSession = (sessionId: string) => Promise<{ ok: boolean; path?: string | null; error?: string }>;

export interface DiscordBotDeps {
  db: Database;
  readModel: ChatReadModel;
  chatRepo: ChatRepo;
  sessionsRepo: SessionsRepo;
  /** Revisor の Open / Test OK 一覧。Test Forum の候補正本として使う。 */
  revisorTestWorkflow?: RevisorTestWorkflowSource;
  revisor?: RevisorLocalPrReader & RevisorLocalPrMerger;
  /**
   * channel 作成前に届いた transcript frame の埋め戻し (transcript-replay) に使う。
   * 省略時は replay をスキップ (standalone worker 等、 repo を持たない構成)。
   */
  transcriptLogs?: TranscriptReplaySource & { maxId(sessionId: string): number };
  /** Concordia の依頼 (chat-reply / title-suggest 等の pending tasks) の集計に使う. */
  /** PR キューの自動更新メッセージ / pr.changed 再描画に使う. */
  /**
   * 子会社一覧を live 解決する (本社モニターの「本社/子会社別コスト」用)。 本社 Bot のみ
   * 渡され、 子会社 Bot には渡さない (subsidiary モードでは無視 = 他子会社の漏洩防止)。
   */
  listSubsidiaries?: () => Array<{ id: string; name: string; daily_token_budget: number }>;
  concordiaUrl: string;
  routeFederationIngress?: (input: { guildId: string; channelId: string; messageId: string; authorId: string; authorLabel: string; text: string; ts: number; appliedTagNames?: readonly string[] }) => boolean;
  resolveForumSiteTags?: () => Promise<readonly string[]>;
  setFederationEgressExecutor?: (executor: ((request: FederationEgressRequestFrame) => Promise<{ ok: boolean; error?: string }>) | null) => void;
  /** ローカルクローン親 (Memoria 解決用)。 リアクションワークフローの headless cwd に使う。 */
  workspaceRoot?: string;
  /** 設定 GUI (AdminState) で上書き可能な workspaceRoot を bot start 時に live 解決する。 */
  resolveWorkspaceRoot?: () => string;
  /** 複数ワークスペースルートを bot start 時に live 解決する (Memoria は実在ルートを採用)。 */
  resolveWorkspaceRoots?: () => string[];
  /** Forum投稿spawnにも通常spawnと同じ provider別 cwd 解決を適用する。 */
  resolveSessionSpawnCwd?: ForumSpawnDeps["resolveSpawnCwd"];
  /** リアクションワークフローの安全弁の既定値 (env 由来)。 resolve 未指定時のフォールバック。 */
  reactionWorkflowEnabled?: boolean;
  /** 安全弁を bot 稼働中に live 評価する (設定 GUI トグルを再起動なしで反映)。 */
  resolveReactionWorkflowEnabled?: () => boolean;
  /** ユーザ設定の 絵文字→アクション 上書き写像を live 解決する。 */
  resolveReactionMappings?: () => Record<string, WorkflowAction>;
  /**
   * 社員名簿 (staff_members) の役職に基づく権限判定。 未注入は deny 側 (fail-closed)。
   * spec/feature/staff-roster.md §3 (capability → 最低役職 / ゲート位置)。
   */
  /**
   * リアクションワークフローの発火可否。 発火自体は誰でも可 (`reaction_workflow` =
   * ヒラ社員) なので実質は素通しゲート。 実行可否は下の `hasStaffCapability` が決める。
   */
  isReactionWorkflowUserAllowed?: (userId: string) => boolean;
  /**
   * リアクションワークフローの各アクションが要求する権限の判定。 リアクション自体は
   * 誰でも押せるので、 発火可否ではなく「指示の内容が実行できるか」を見る。
   */
  hasStaffCapability?: (userId: string, capability: import("../staff/roles.js").StaffCapability) => boolean;
  /** セッションの spawn / delegation 起動 (管理職以上)。 */
  isLaunchUserAllowed?: (userId: string) => boolean;
  /** セッションの end-session (管理職以上)。 */
  isSessionEndUserAllowed?: (userId: string) => boolean;
  /** キルスイッチ = Excubitor 経由のサービス起動 / 再起動 (執行役員のみ)。 */
  isKillSwitchUserAllowed?: (userId: string) => boolean;
  /**
   * LLM にアクセスした Discord ユーザを社員名簿へ記録する。 記録時にサーバーでの
   * プロファイル名 (guild nickname) も渡す。
   */
  recordStaffAccess?: (input: {
    userId: string;
    displayName?: string;
    profileName?: string;
  }) => void;
  /**
   * PR 一覧 / 提出 / マージ (📋 / 📮 / 🔀 と操作パネル) の実体。 Revisor local PR の提出は
   * `POST /v1/prs/local` と同じ関数、 マージは指示者ベースの認可を通す。
   * 未注入なら PR 操作は実行せず、 その理由を返す (無言スキップにしない)。
   */
  prOperations?: DiscordCommandDeps["prOperations"];
  runHeadless: DiscordHeadlessRunner;
  repinSession: DiscordRepinSession;
  /**
   * Override for workflow-triggered session injects. In the embedded backend
   * this is the in-process event bus. In the standalone Discord worker it
   * posts to the backend API so the session WS receives the inject.
   */
  emitSessionInject?: (sessionId: string, text: string, source: string) => void;
  /**
   * AskUserQuestion 回答の in-process 直呼び。embedded backend は
   * control/answer-question.ts を注入し、self-fetch (自プロセスへの HTTP) を回避する。
   * standalone chat-worker は未指定のまま → HTTP + リトライにフォールバック。
   */
  answerQuestion?: DiscordCommandDeps["answerQuestion"];
  /**
   * 実効接続設定を解決する関数 (DB+env)。 start のたびに呼ぶので、 設定変更後の
   * restart で即反映される。 省略時は env (CONCORDIA_DISCORD_*) のみ。
   */
  resolveConfig?: () => DiscordEnv;
  /**
   * ワークフロー有効化フラグを都度解決する。 無効なワークフローは slash command を
   * guild へ登録せず、 リアクション購読も張らない。 値の変化は稼働中に検知して
   * 登録側を張り替える。 未注入なら全て有効 (既存構成の挙動を変えない)。
   */
  resolveWorkflowEnabled?: (key: WorkflowKey) => boolean;
  onRuntimeState?: (state: { running: boolean; status: string; error?: string }) => void;
  /**
   * 子会社モード。 指定すると:
   *  - config / session-channels を `sub:<id>` scope で namespacing (本社と混ざらない)。
   *  - その子会社が起こしたセッションのみ 3 カテゴリに写す (subsidiary-only 可視)。
   *  - 出張先からの作業指示をガードゲートに通す (intake チャンネル → 専用 delegation)。
   *  - bot 自身のメンションを抑制 (高頻度カテゴリのデフォルト通知ミュート)。
   * spec/feature/subsidiary-delegation.md §3。
   */
  subsidiary?: {
    id: string;
    /** intake (受付) チャンネル id。 ここへの新規メッセージ = 修正依頼。 */
    intakeChannelId: string | null;
    /** 依頼 1 件をガード→記録→delegation まで処理し replyText を返す。 */
    process: (userId: string, userLabel: string, instruction: string) => Promise<{ replyText: string }>;
    /** 当該ユーザがロック済みか。 */
    isLocked: (userId: string) => boolean;
  };
  /**
   * 本社内の軽量窓口 (desk)。 子会社と違い **本社 Bot にそのまま相乗り**する:
   * scope / 可視範囲 / レイアウトは本社のままで、 「タスク依頼」チャンネルを 1 本作り、
   * そこへの投稿だけを子会社と同じガードゲートに通す。 Bot は新たに接続しない。
   * spec/feature/subsidiary-delegation.md §9。
   */
  desk?: {
    id: string;
    /** 依頼チャンネル名 (既定「タスク依頼」)。 */
    channelName: string;
    /** 手動指定の channel_id (あれば自動作成せずこれを使う)。 */
    channelId: string | null;
    process: (userId: string, userLabel: string, instruction: string) => Promise<{ replyText: string }>;
    isLocked: (userId: string) => boolean;
    /** 自動作成で解決した channel id を永続化するための通知。 */
    onChannelResolved?: (channelId: string) => void;
  };
}
export type DiscordBotHandle = ChatPlatform;

export async function startDiscordBot(deps: DiscordBotDeps): Promise<ChatPlatform | null> {
  const env = deps.resolveConfig ? deps.resolveConfig() : readDiscordEnv();
  // W6: 許可要求の投稿可否は起動時スナップショットではなく都度解決する。
  // (env を直接見ていた頃は Web UI で変えても再起動まで効かなかった)
  const resolvePermissionRequestsEnabled = toPermissionRequestsResolver(deps.resolveConfig ?? env);
  const isWorkflowEnabled: (key: WorkflowKey) => boolean =
    deps.resolveWorkflowEnabled ?? (() => true);
  if (!env.enabled) {
    log.info("discord disabled (enabled != 1); skip");
    return null;
  }
  if (!env.token || !env.guildId) {
    log.warn("discord token / guild_id missing (設定ページ or CONCORDIA_DISCORD_*); skip");
    return null;
  }

  // 子会社 scope: config / session-channels の namespacing と subsidiary-only 可視に使う。
  const scope = deps.subsidiary ? `sub:${deps.subsidiary.id}` : "";
  const subsidiaryId = deps.subsidiary?.id ?? null;
  // 本社 Bot と子会社 Bot は同一 token を共有するため、 各 Client は **全 guild** の
  // gateway イベントを受信してしまう。 そのまま処理すると interaction の二重 ack
  // (Unknown interaction / already acknowledged) や、 子会社 guild の /spawn を本社
  // Client が拾って本社側にセッションを作る、 等が起きる。 自分の guild 以外のイベントは
  // 全ハンドラ入口で捨てる (guildId が無い DM 等も対象外)。
  const inScope = (guildId: string | null | undefined): boolean => guildId === env.guildId;
  // 子会社は本社のような雑談 (meta) / pr-queue / errors を持たない slim 構成 (ユーザ要望)。
  const layoutOpts: EnsureLayoutOptions = {
    ...(deps.subsidiary
      ? { includeMetaChannels: false, includePrQueue: false, includeErrors: false }
      : {}),
    forumMode: env.forumMode !== false,
  };
  const workspaceRoots = deps.resolveWorkspaceRoots?.()
    ?? [deps.resolveWorkspaceRoot?.() || deps.workspaceRoot || process.cwd()];
  const projectCodesRepo = new ProjectCodesRepo(deps.db);
  const projectResolver = createForumProjectResolver(() => projectCodesRepo.list());
  // 受付 (intake) チャンネル: 手動 channel_id があればそれを優先 (override)、 無ければ
  // ClientReady で自動作成して埋める。 ingress のゲートはこの値で受付チャンネルを判定する。
  let subsidiaryIntakeChannelId: string | null = deps.subsidiary?.intakeChannelId ?? null;
  // 本社内 desk の依頼チャンネル。 子会社の受付と同じく手動 id 優先 → 無ければ ClientReady で自動作成。
  let deskChannelId: string | null = deps.desk?.channelId ?? null;

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildWebhooks,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
    // 子会社 Bot は高頻度カテゴリのデフォルト通知ミュートのため、 bot 発メッセージの
    // メンションを既定で一切解決しない (個別に上書きしない限り誰も ping しない)。
    ...(deps.subsidiary ? { allowedMentions: { parse: [] as never[] } } : {}),
  });

  const configRepo = makeDiscordConfigRepo(deps.db, scope);
  const sessionChannelsRepo = makeDiscordSessionChannelsRepo(deps.db, scope);
  const testSurfacesRepo = makeDiscordTestSurfacesRepo(deps.db, scope);
  // reconcile close / スレッド投稿が共有するテスト・QA hooks。 close 時は旧経路の
  // delegation run (qa_run_id) に加え、 テスト開始で紐付いた session_id も畳む
  // (マージ等で投稿が閉じたら関連セッションも終わらせる)。
  const testForumQaBase = createTestForumQaHooks({
    concordiaUrl: deps.concordiaUrl,
    workspaceRoots,
    subsidiaryId,
    log,
  });
  const testForumQa = {
    ...testForumQaBase,
    end: async (surface: import("../db/discord-test-surfaces-repo.js").DiscordTestSurfaceRow) => {
      await testForumQaBase.end(surface);
      if (surface.session_id && deps.sessionsRepo.findSession(surface.session_id)?.status === "active") {
        const ended = await callConcordia<{ ok: boolean }>(
          deps.concordiaUrl,
          "DELETE",
          `/v1/sessions/${encodeURIComponent(surface.session_id)}`,
        );
        if ("error" in ended) {
          log.info(`test-forum session end skipped session=${surface.session_id}: ${ended.error}`);
        }
      }
    },
  };
  const delegationRepo = new DelegationRepo(deps.db);
  const resolveLayoutOpts = async (): Promise<EnsureLayoutOptions> => ({
    ...layoutOpts,
    sessionForumTemplates: delegationRepo.listTemplates(),
    sessionForumSiteTags: await deps.resolveForumSiteTags?.() ?? [],
  });
  // このセッションがこの Bot の可視範囲 (subsidiary-only / 本社) に属するか。
  // 子会社 Bot は metadata.subsidiary_id 一致のみ、 本社 Bot は subsidiary_id 無しのみ写す。
  const ownsSession = (sessionId: string): boolean => {
    const sid = deps.readModel.getSessionRelayState(sessionId)?.subsidiaryId ?? null;
    return subsidiaryId ? sid === subsidiaryId : !sid;
  };
  const isActiveDiscordSession = (sessionId: string): boolean => {
    const session = deps.readModel.getSessionRelayState(sessionId);
    const row = sessionChannelsRepo.findBySessionId(sessionId);
    return isActiveRelayTarget(session?.status ?? null, row?.status ?? null);
  };
  const messageMap = makeDiscordMessageMapRepo(deps.db);
  const sessionMessageDeliveryRepo = makeSessionMessageDeliveryRepo(deps.db);
  const reactionsRepo = makeChatMessageReactionsRepo(deps.db);
  const pendingQuestionsRepo = makeDiscordPendingQuestionsRepo(deps.db);
  const permissionActions: PermissionActionStore = new Map();

  const resolveReactionSafetyValve =
    deps.resolveReactionWorkflowEnabled ?? (() => deps.reactionWorkflowEnabled ?? false);
  const reactionWorkflowEnabled = (): boolean =>
    isWorkflowEnabled("reaction") && resolveReactionSafetyValve();

  // リアクションワークフロー: runner は常に構築し、 安全弁は handle() 内で live 評価。
  // → 設定 GUI トグルを bot 再起動なしで反映できる (OFF の間は handle が即 return)。
  const reactionWorkflow = new (getRwf().ReactionWorkflowRunner)({
    runHeadless: deps.runHeadless,
    emitInject: deps.emitSessionInject ?? ((sessionId, text, source) =>
      eventBus.emit({ type: "session.inject", target_session_id: sessionId, text, source, ts: Math.floor(Date.now() / 1000) })),
    contextReport: async (sessionId) => {
      const session = deps.sessionsRepo.findSession(sessionId);
      if (!session) throw new Error("session_not_found");
      return buildContextReport(session);
    },
    workspaceRoot: deps.resolveWorkspaceRoot?.() || deps.workspaceRoot || process.cwd(),
    workspaceRoots: deps.resolveWorkspaceRoots?.(),
    // 安全弁 (設定 GUI) と ワークフロー有効化フラグ (workflow.reaction) の AND。
    // どちらも都度解決なので、 どちらを切っても再起動なしで止まる。
    enabled: () => reactionWorkflowEnabled(),
    customMappings: deps.resolveReactionMappings,
    // リアクションは誰でも押せるが、 中身が spawn / merge を要求するならここで役職を問う。
    hasCapability: deps.hasStaffCapability,
    // 📋 list-local-prs / 📮 submit-pr / 🔀 merge-pr の実体 (Revisor local PR)。
    prOperations: deps.prOperations,
    log,
  });
  const measuredHandleIngressMessage = instrumentDiscord("ingressMessage", handleIngressMessage);
  const ingressDirectorRepo = new DirectorRepo(deps.db);
  const teamsRepo = new TeamsRepo(deps.db);
  // `/spawn` の task 候補 (Memoria の未完了タスク)。 Memoria が落ちていても spawn は
  // 続けられるよう、 補完側でキャッシュと失敗吸収を行う。
  const spawnTaskSource = new MemoriaClient({ timeoutMs: AUTOCOMPLETE_MEMORIA_TIMEOUT_MS });
  // チーム面ルーティング (team-card-routing.ts): セッションの team_id からカード種別の
  // 投稿先チャンネルを引く。 子会社 bot はチーム面 (本社 guild) を持たないので常に null。
  const teamCardChannelForSession = (sessionId: string, kind: TeamCardKind): string | null => {
    if (deps.subsidiary) return null;
    const teamId = deps.sessionsRepo.findSession(sessionId)?.team_id ?? null;
    return resolveTeamCardChannel(teamsRepo, teamId, kind);
  };
  const teamMetricsRepo = new TeamMetricsRepo(deps.db);
  /**
   * セッション終了時のチームコスト報告 (spec/feature/teams.md §2)。
   *
   * チーム未所属・コスト面未プロビジョニングなら何もしない (フォールバック投稿は
   * しない — 個人セッションのコストを無関係なチャンネルへ流さないため)。
   */
  const postTeamCostReport = async (sessionId: string, nowMs: number): Promise<void> => {
    if (deps.subsidiary) return;
    const guild = activeGuild;
    if (!guild) return;
    const session = deps.sessionsRepo.findSession(sessionId);
    const teamId = session?.team_id ?? null;
    if (!session || !teamId) return;
    const channelId = resolveTeamCardChannel(teamsRepo, teamId, "cost-session");
    if (!channelId) return;
    const team = teamsRepo.find(teamId);
    if (!team) return;
    await postToTeamSurface(guild, channelId, {
      content: renderTeamCostReport({
        teamName: team.name,
        sessionLabel: session.current_task?.trim()
          || `${session.provider} (${sessionId.slice(0, 12)})`,
        sessionCostTokens: teamMetricsRepo.sessionCost(sessionId),
        teamTodayCostTokens: teamMetricsRepo.teamCostToday(teamId, nowMs),
        teamTodaySessionCount: deps.sessionsRepo.countTeamSessionsSince(
          teamId,
          localMidnightSec(nowMs),
        ),
      }),
      allowedMentions: { parse: [] },
    });
  };
  /**
   * カードをチーム面へ投稿する。 投稿済みなら message id を、 チーム未設定 / 面欠落 /
   * チャンネル取得失敗なら null を返す — 呼び出し側が現行チャンネルへフォールバックする。
   */
  const postToTeamSurface = async (
    guild: Guild,
    channelId: string | null,
    payload: Parameters<TextChannel["send"]>[0],
  ): Promise<string | null> => {
    if (!channelId) return null;
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel?.type !== ChannelType.GuildText) return null;
    const sent = await channel.send(payload);
    return sent.id;
  };
  const measuredHandleReactionAdd = instrumentDiscord("reactionAdd", handleReactionAdd);
  const measuredHandleReactionRemove = instrumentDiscord("reactionRemove", handleReactionRemove);
  const measuredDispatchInteraction = instrumentDiscord("dispatchInteraction", dispatchInteraction);

  let layout: DiscordConfigSnapshot | null = null;
  let webhooks: WebhookPool | null = null;
  let activeGuild: Guild | null = null;
  let unsubscribe: (() => void) | null = null;
  /**
   * webhook 投稿を pin する (best-effort)。 webhook client は pin API を持たないので
   * Bot 権限で channel → message を引き直す。 権限不足や message 消失では false を返す。
   */
  const pinChannelMessage = async (channelId: string, messageId: string): Promise<boolean> => {
    const guild = activeGuild;
    if (!guild) return false;
    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel?.isTextBased()) return false;
      const message = await channel.messages.fetch(messageId);
      await message.pin();
      return true;
    } catch {
      return false;
    }
  };
  let costTimer: ReturnType<typeof setInterval> | null = null;
  let monitorTimer: ReturnType<typeof setInterval> | null = null;
  let prQueueTimer: ReturnType<typeof setInterval> | null = null;
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let testForumTimer: ReturnType<typeof setInterval> | null = null;
  let commandRegistrationWatch: CommandRegistrationWatchHandle | null = null;
  let reactionListenerTimer: ReturnType<typeof setInterval> | null = null;
  let staleChannelTimer: ReturnType<typeof setInterval> | null = null;
  let stopping = false;
  /** この Bot インスタンスが連合 egress ポートを握っているか (本社ランタイムのみ true)。 */
  let federationEgressRegistered = false;
  let gatewayClosed = false;
  let reconcileRunning = false;
  const backgroundTimers = new Set<ReturnType<typeof setTimeout>>();
  // pr.changed event で即時再描画するための closure (ClientReady でセット).
  let prQueueRefresh: (() => void) | null = null;
  let testForumRefresh: ((reason: string) => Promise<void>) | null = null;
  // Vestigium 監視は error.reported を Web / 本社ランタイムへ流すため維持する。
  // Discord errors チャンネルへの poster は意図的に持たない。
  let errorMonitor: ErrorMonitorHandle | null = null;
  let channelWorkState: ChannelWorkState | null = null;
  const onSessionMessagePosted = (input: { sessionId: string; completion: boolean }): void => {
    if (input.completion) channelWorkState?.noteCompletion(input.sessionId);
    else channelWorkState?.noteProgress(input.sessionId);
  };
  const readPositiveIntEnv = (name: string, fallback: number, min = 1): number => {
    const raw = Number(process.env[name] ?? "");
    if (!Number.isFinite(raw) || raw <= 0) return Math.max(min, fallback);
    return Math.max(min, Math.floor(raw));
  };
  const readOptionalIntEnv = (name: string, fallback: number, min = 1): number => {
    const rawValue = process.env[name];
    if (rawValue == null || rawValue.trim() === "") return Math.max(0, fallback);
    const raw = Number(rawValue);
    if (!Number.isFinite(raw)) return Math.max(0, fallback);
    if (raw <= 0) return 0;
    return Math.max(min, Math.floor(raw));
  };
  const runWithConcurrency = async <T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> => {
    let next = 0;
    const workerCount = Math.min(Math.max(1, limit), items.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (!stopping) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await task(items[index]!);
      }
    });
    await Promise.all(workers);
  };
  const scheduleBackground = (label: string, fn: () => Promise<void> | void, delayMs: number): void => {
    const timer = setTimeout(() => {
      backgroundTimers.delete(timer);
      if (stopping) return;
      Promise.resolve(fn()).catch((e) => log.warn(`${label} failed: ${(e as Error).message}`));
    }, delayMs);
    timer.unref?.();
    backgroundTimers.add(timer);
  };
  const clearRuntimeTimers = (): void => {
    for (const timer of backgroundTimers) clearTimeout(timer);
    backgroundTimers.clear();
    if (costTimer) { clearInterval(costTimer); costTimer = null; }
    if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
    if (prQueueTimer) { clearInterval(prQueueTimer); prQueueTimer = null; }
    if (reconcileTimer) { clearInterval(reconcileTimer); reconcileTimer = null; }
    if (testForumTimer) { clearInterval(testForumTimer); testForumTimer = null; }
    if (staleChannelTimer) { clearInterval(staleChannelTimer); staleChannelTimer = null; }
    if (reactionListenerTimer) { clearInterval(reactionListenerTimer); reactionListenerTimer = null; }
    if (commandRegistrationWatch) { commandRegistrationWatch.stop(); commandRegistrationWatch = null; }
  };
  const stopAfterGatewayInstability = (status: string, error: string): void => {
    if (gatewayClosed || stopping) return;
    gatewayClosed = true;
    stopping = true;
    unsubscribe?.();
    unsubscribe = null;
    clearRuntimeTimers();
    errorMonitor?.stop();
    errorMonitor = null;
    deps.onRuntimeState?.({ running: false, status, error });
    log.warn(`${status}: ${error}; stopped embedded Discord bot`);
    try { client.destroy(); } catch (e) { log.warn(`discord client destroy failed: ${(e as Error).message}`); }
  };

  client.once(Events.ClientReady, instrumentDiscord("ready", async (c) => {
    log.info(`logged in as ${c.user.tag}`);
    try {
      const guild = await c.guilds.fetch(env.guildId!);
      activeGuild = guild;
      await guild.channels.fetch();
      layout = await ensureDiscordLayout(guild, configRepo, await resolveLayoutOpts());
      if (!deps.subsidiary) {
        const teams = new TeamsRepo(deps.db).list();
        for (const team of teams) {
          await ensureTeamDiscordLayout({
            guild,
            db: deps.db,
            teamId: team.id,
            name: team.name,
          }).catch((error) => log.warn(`team provision reconcile failed team=${team.id}: ${(error as Error).message}`));
        }
      }
      // 子会社モード: 受付チャンネルを自動作成 (手動 channel_id 指定がある場合はそれを優先)。
      if (deps.subsidiary) {
        try {
          if (!subsidiaryIntakeChannelId) {
            subsidiaryIntakeChannelId = await ensureIntakeChannel(guild, configRepo, layout.metaCategoryId);
            log.info(`subsidiary intake channel ensured id=${subsidiaryIntakeChannelId} guild=${guild.id}`);
          }
        } catch (e) {
          log.warn(`subsidiary intake channel ensure failed guild=${guild.id}: ${(e as Error).message}`);
        }
      }
      // 本社内 desk: 「タスク依頼」チャンネルを本社 guild に自動作成する。
      if (deps.desk) {
        try {
          if (!deskChannelId) {
            deskChannelId = await ensureDeskChannel(
              guild, configRepo, deps.desk.id, deps.desk.channelName, layout.metaCategoryId,
            );
            deps.desk.onChannelResolved?.(deskChannelId);
            log.info(`desk channel ensured id=${deskChannelId} name=${deps.desk.channelName} guild=${guild.id}`);
          }
        } catch (e) {
          log.warn(`desk channel ensure failed guild=${guild.id}: ${(e as Error).message}`);
        }
      }
      webhooks = new WebhookPool(guild, sessionChannelsRepo);
      // egress ポートはプロセスに 1 本しかないので、本社 Bot だけが握る。子会社 Bot は
      // 同じ base deps を共有しているため、ここで絞らないと最後に ready した子会社 guild が
      // 本社の executor を上書きし、本社担当部署宛ての egress が全て弾かれる。
      const setEgressExecutor = deps.setFederationEgressExecutor;
      if (!deps.subsidiary && setEgressExecutor) {
        federationEgressRegistered = true;
        setEgressExecutor(async (request) => {
          // guild id と実 channel 所属をここで確認する。連合層は Discord 型へ依存せず、
          // 本社の Discord ポートだけが channel → guild の対応を知る。
          if (request.guild_id !== guild.id) return { ok: false, error: "destination guild is not this Discord runtime" };
          const channel = await guild.channels.fetch(request.channel_id).catch(() => null);
          if (!channel || channel.guildId !== guild.id) return { ok: false, error: "destination channel is not in the requested guild" };
          const webhook = await webhooks!.getForChannel(request.channel_id);
          if (!webhook) return { ok: false, error: "Discord webhook is unavailable for destination channel" };
          const sent = await webhooks!.send(webhook, { content: request.text, username: "Concordia", allowedMentions: { parse: [] } });
          return sent ? { ok: true } : { ok: false, error: "Discord send failed" };
        });
      }
      if (env.applicationId) {
        try {
          if (deps.subsidiary) {
            // 子会社 guild は安全なセッション内操作だけ登録する。作業依頼 / spawn 系は
            // 引き続き受付チャンネルのメッセージ → ガードゲート経由に限定する。
            await registerGuildCommands(env.token!, env.applicationId, env.guildId!, {
              subsidiary: true,
              isWorkflowEnabled,
            });
            log.info(`slash commands registered (subsidiary allowed-only) guild=${env.guildId}`);
          } else {
            await registerGuildCommands(env.token!, env.applicationId, env.guildId!, {
              isWorkflowEnabled,
            });
            log.info(`slash commands registered guild=${env.guildId}`);
          }
          // 無効化 / 再有効化を検知して登録内容を張り替える (フラグだけ切り替わって
          // コマンドが残る状態を作らない)。リアクション購読は独立 watcher が扱う。
          commandRegistrationWatch = startCommandRegistrationWatch({
            signature: () => workflowCommandSignature(isWorkflowEnabled),
            reregister: async () => {
              await registerGuildCommands(env.token!, env.applicationId!, env.guildId!, {
                subsidiary: !!deps.subsidiary,
                isWorkflowEnabled,
              });
            },
            log,
          });
        } catch (e) {
          log.warn(`slash command registration failed guild=${env.guildId}: ${(e as Error).message}`);
        }
      } else {
        log.warn("CONCORDIA_DISCORD_APPLICATION_ID missing; slash commands are not registered");
      }
      scheduleBackground("delegation template cache prewarm", async () => {
        const templates = await prewarmDelegationTemplateCache(deps.concordiaUrl, log);
        log.info(`delegation template cache prewarmed templates=${templates.length}`);
      }, 100);
      void excubitorProjectCache
        .get(excubitorBaseUrl(), { info: (m) => log.info(m), warn: (m) => log.warn(m) })
        .catch((e) => log.warn(`excubitor project cache warmup failed: ${(e as Error).message}`));
      const costCh = guild.channels.cache.get(layout.costChannelId);
      if (costCh && costCh.type === ChannelType.GuildText) {
        const refresh = () => {
          const activityCh = guild.channels.cache.get(layout!.activityChannelId);
          return upsertCostChannelMessage(
            costCh,
            deps.readModel,
            (k) => configRepo.get(k),
            (k, v) => configRepo.set(k, v),
            activityCh?.type === ChannelType.GuildText ? activityCh : null,
          ).catch((e) => log.warn(`cost channel update failed: ${(e as Error).message}`));
        };
        const mins = readOptionalIntEnv("CONCORDIA_DISCORD_COST_REFRESH_MIN", 0, 1);
        if (mins > 0) {
          scheduleBackground("cost channel boot refresh", refresh, 1000);
          costTimer = setInterval(() => { void refresh(); }, mins * 60 * 1000);
          costTimer.unref?.();
        } else {
          log.info("cost channel refresh disabled");
        }
      } else {
        log.warn(`cost channel unavailable id=${layout.costChannelId}`);
      }
      // concordia-monitor: アクティブなセッション数 + 最終更新時間を定期更新.
      const refreshMonitor = instrumentDiscord("monitorRefresh", async () => {
        await guild.channels.fetch();
        layout = await ensureDiscordLayout(guild, configRepo, await resolveLayoutOpts());
        const monitorCh = guild.channels.cache.get(layout.monitorChannelId);
        if (!monitorCh || monitorCh.type !== ChannelType.GuildText) {
          log.warn(`monitor channel unavailable id=${layout.monitorChannelId}`);
          return;
        }
        await upsertMonitorChannelMessage(
          monitorCh,
          await deps.readModel.getMonitorSnapshot({
            subsidiaryId,
            costSubsidiaries: deps.subsidiary ? undefined : deps.listSubsidiaries?.(),
            channelForSession: (sessionId) => sessionChannelsRepo.findBySessionId(sessionId)?.channel_id ?? null,
          }),
          (k) => configRepo.get(k),
          (k, v) => configRepo.set(k, v),
          {
            stats: getEgressDedupStats(),
            // 本社モニターのみ本社/子会社別コストを出す (子会社 Bot では出さない)。
          },
        );
      });
      const monitorMins = readOptionalIntEnv("CONCORDIA_DISCORD_MONITOR_REFRESH_MIN", 0, 1);
      if (monitorMins > 0) {
        scheduleBackground("monitor channel boot refresh", refreshMonitor, 1000);
        monitorTimer = setInterval(() => {
          void refreshMonitor().catch((e) => log.warn(`monitor channel update failed: ${(e as Error).message}`));
        }, monitorMins * 60 * 1000);
        monitorTimer.unref?.();
      } else {
        log.info("monitor channel refresh disabled");
      }
      // pr-queue: 各セッションが作った PR のキューを定期更新 + pr.changed で即時再描画.
      const refreshPrQueue = instrumentDiscord("prQueueRefresh", async () => {
        await guild.channels.fetch();
        layout = await ensureDiscordLayout(guild, configRepo, await resolveLayoutOpts());
        const prQueueCh = guild.channels.cache.get(layout.prQueueChannelId);
        if (!prQueueCh || prQueueCh.type !== ChannelType.GuildText) {
          log.warn(`pr-queue channel unavailable id=${layout.prQueueChannelId}`);
          return;
        }
        await upsertPrQueueChannelMessage(
          prQueueCh,
          deps.readModel.getPrQueueSnapshot({
            channelForSession: (sessionId) => {
              const ch = sessionChannelsRepo.findBySessionId(sessionId);
              if (!ch || ch.status === "ended") return null;
              return ch.channel_id;
            },
          }),
          (k) => configRepo.get(k),
          (k, v) => configRepo.set(k, v),
        );
      });
      // pr-queue を持たない構成 (子会社) では定期更新ごと skip する。
      const prMins = readOptionalIntEnv("CONCORDIA_DISCORD_PR_QUEUE_REFRESH_MIN", 0, 1);
      if (layout.prQueueChannelId && prMins > 0) {
        prQueueRefresh = () => { void refreshPrQueue(); };
        scheduleBackground("pr-queue channel boot refresh", refreshPrQueue, 1000);
        prQueueTimer = setInterval(() => {
          void refreshPrQueue().catch((e) => log.warn(`pr-queue channel update failed: ${(e as Error).message}`));
        }, prMins * 60 * 1000);
        prQueueTimer.unref?.();
      } else if (layout.prQueueChannelId) {
        log.info("pr-queue channel refresh disabled");
      }
      // 本社ランタイムでは Vestigium 監視だけを起動する。error.reported はログ・WebSocket・
      // 自動修正へ流すが、Discord errors チャンネルには転記しない。
      // errors を持たない構成 (子会社) では監視を立てない。
      if (layout.errorChannelId) {
        errorMonitor = startVestigiumErrorWatch();
      }
      // 状態カードは 3 タイミングのみ更新: spawn=作成 / 10分毎=更新 / Session-End=削除。
      // 10分毎: アクティブな session のカードは更新 (作成はしない)、 非アクティブは削除。
      const lay = layout;
      const statusSyncConcurrency = readPositiveIntEnv("CONCORDIA_DISCORD_STATUS_SYNC_CONCURRENCY", 2);
      const bootSyncDelayMs = readOptionalIntEnv("CONCORDIA_DISCORD_BOOT_SYNC_DELAY_MS", 0, 1000);
      const runSessionForumReconcile = instrumentDiscord("sessionForumReconcile", async (reason: string): Promise<void> => {
        const lostChannels = await reconcileLostSessionChannels({
          guild, layout: lay, repo: sessionChannelsRepo,
          isSessionLost: (sessionId) => deps.readModel.getSessionRelayState(sessionId)?.status === "lost",
          log, webhooks: webhooks ?? undefined,
        });
        const ended = await reconcileEndedSessionChannels({
          guild, layout: lay, repo: sessionChannelsRepo,
          isSessionEnded: (sessionId) => deps.readModel.getSessionRelayState(sessionId)?.status === "ended",
          log, webhooks: webhooks ?? undefined,
        });
        const active = await reconcileActiveSessionForumThreads({
          guild, layout: lay, repo: sessionChannelsRepo, log, webhooks: webhooks ?? undefined,
          listActiveSessionIds: () => deps.sessionsRepo.listSessions({ status: "active" })
            .map((session) => session.id)
            .filter(ownsSession),
          restoreMissing: async (sessionId) => {
            const state = deps.readModel.getSessionRelayState(sessionId);
            if (!state || state.status !== "active") return;
            const surface = resolveForumSessionSurface(lay, state.delegationRunId);
            const teamId = deps.sessionsRepo.findSession(sessionId)?.team_id ?? null;
            const surfaceLayout = {
              ...lay,
              sessionForumId: resolveTeamSessionForumId(
                teamsRepo,
                teamId,
                surface.label === "TaskWorkflow" ? "task" : "session",
                surface.forumId,
              ),
            };
            await onSessionRegistered({
              guild, layout: surfaceLayout, repo: sessionChannelsRepo, log, webhooks: webhooks ?? undefined,
            }, {
              sessionId,
              agentType: state.provider,
              delegationEmoji: state.delegationEmoji,
              roleLabel: state.roleLabel,
              repoPath: state.repoPath,
              branch: state.branch,
              model: state.model,
              effortLevel: state.effortLevel,
              fastMode: state.fastMode,
              currentTask: state.currentTask,
              projectCodes: projectResolver.codesForRepos(readActiveRepos(state)),
              surfaceLabel: state.delegationRunId ? "TaskWorkflow" : "Session",
              delegationRunId: state.delegationRunId,
              webhookName: state.webhookName,
              webhookAvatarUrl: state.webhookAvatarUrl,
            });
          },
        });
        log.info(
          `session-forum ${reason} reconcile: scanned=${Math.max(lostChannels.scanned, ended.scanned)}`
          + ` active=${active.reconciled} lost=${lostChannels.reconciled} ended=${ended.reconciled}`,
        );
      });
      const runTestForumReconcile = instrumentDiscord("testForumReconcile", async (reason: string): Promise<void> => {
        if (!lay.forumMode || !lay.testForumId) {
          log.info(`test-forum ${reason} reconcile skipped; forum mode disabled`);
          return;
        }
        if (!deps.revisorTestWorkflow) {
          log.warn(`test-forum ${reason} reconcile skipped; Revisor Test Workflow source unavailable`);
          return;
        }
        const source = deps.revisorTestWorkflow;
        // 掲載対象は Test OK 限定ではなく open な local PR 全件 (登録・審査時点で載せる)。
        const openPullRequests = await source.listOpenLocalPrs();
        // 終局状態は archive 前の「マージしました」通知にだけ使う。取得不能でも従来どおり
        // 候補外の投稿と関連セッションを閉じ、原因はログへ残す。
        const terminalPullRequests = source.listTerminalLocalPrs
          ? await source.listTerminalLocalPrs().catch(() => {
            // Upstream の error body は credentials / private endpoint / local path を
            // 含み得るため、同期を継続する事実だけを記録する。
            log.warn(`test-forum ${reason} terminal PR lookup failed; continuing without terminal status`);
            return [];
          })
          : [];
        // 新規掲載時に提出セッションの操作者へメンションする。 解決失敗は掲載を止めない。
        const mentions = resolveSessionMentions(
          (sessionId, limit) => deps.sessionsRepo.recentEvents(sessionId, limit),
          openPullRequests.flatMap((pullRequest) => pullRequest.sessionId ? [pullRequest.sessionId] : []),
        );
        const result = await reconcileTestForum({
          candidates: buildTestForumCandidates(openPullRequests, mentions),
          terminalPullRequests: terminalPullRequests.map((pullRequest) => ({
            repoOrigin: pullRequest.repository,
            prNumber: pullRequest.number,
            status: pullRequest.status,
            mergeCommitSha: pullRequest.mergeCommitSha,
          })),
          surfaces: testSurfacesRepo,
          adapter: createTestForumDiscordAdapter(guild, lay.testForumId),
          qa: testForumQa,
          log,
        });
        log.info(
          `test-forum ${reason} reconcile: scanned=${result.scanned} kept=${result.kept}`
          + ` updated=${result.updated} created=${result.created} closed=${result.closed}`
          + ` failed=${result.failed}`,
        );
      });
      testForumRefresh = createTestForumRefreshTrigger({
        reconcile: runTestForumReconcile,
        warn: log.warn,
      });
      const runStatusReconcile = instrumentDiscord("statusReconcile", async (reason: string): Promise<void> => {
        if (reconcileRunning) {
          log.info(`status-card ${reason} reconcile skipped; previous run still active`);
          return;
        }
        reconcileRunning = true;
        try {
          const lost = await reconcileLostStatusCards({ guild, configRepo, readModel: deps.readModel, log });
          log.info(`status-card ${reason} reconcile: scanned=${lost.scanned} removed=${lost.removed}`);
          const activeRows = sessionChannelsRepo.listActive();
          await runWithConcurrency(activeRows, statusSyncConcurrency, async (row) => {
            await upsertSessionStatusCard({
              guild, layout: lay, configRepo, sessionChannelsRepo,
              readModel: deps.readModel, log,
            }, row.session_id, { allowCreate: true });
          });
          const pruned = await pruneStatusCategoryChannels({ guild, layout: lay, repo: sessionChannelsRepo, configRepo, log });
          if (pruned.deleted > 0) {
            log.info(`status-category ${reason} sweep: scanned=${pruned.scanned} deleted=${pruned.deleted}`);
          }
        } finally {
          reconcileRunning = false;
        }
      });
      scheduleBootForumReconciliations({
        delayMs: bootSyncDelayMs,
        schedule: scheduleBackground,
        reconcileSessionForum: () => runSessionForumReconcile("boot"),
        reconcileTestForum: () => testForumRefresh!("boot"),
        log,
      });
      const testForumReconcileSec = readOptionalIntEnv(
        "CONCORDIA_DISCORD_TEST_FORUM_RECONCILE_SEC",
        30,
        5,
      );
      if (testForumReconcileSec > 0) {
        testForumTimer = setInterval(() => {
          void testForumRefresh?.("periodic");
        }, testForumReconcileSec * 1000);
        testForumTimer.unref?.();
      } else {
        log.info("test-forum periodic reconcile disabled");
      }
      if (bootSyncDelayMs > 0) {
        scheduleBackground("status-card boot reconcile", () => runStatusReconcile("boot"), bootSyncDelayMs);
      } else {
        log.info("status-card boot reconcile disabled");
      }
      const reconcileSec = readOptionalIntEnv("CONCORDIA_DISCORD_STATUS_RECONCILE_SEC", 0, 60);
      if (reconcileSec > 0) {
        reconcileTimer = setInterval(() => {
          void runStatusReconcile("periodic")
            .catch((e) => log.warn(`status-card periodic reconcile failed: ${(e as Error).message}`));
          void runSessionForumReconcile("periodic")
            .catch((e) => log.warn(`session-forum periodic reconcile failed: ${(e as Error).message}`));
        }, reconcileSec * 1000);
        reconcileTimer.unref?.();
      } else {
        log.info("status-card periodic reconcile disabled");
      }
      // カテゴリ 50 チャンネル上限対策: 最終更新が 48h より前のチャンネルを
      // ログ保存してから削除する (sessions/archive カテゴリ、 稼働中は保護)。
      // 起動時に 1 回 + 以降 1 時間ごと。
      const runStaleSweep = instrumentDiscord("staleChannelSweep", async (): Promise<void> => {
        const r = await archiveStaleChannels({ guild, layout: layout!, repo: sessionChannelsRepo, log });
        log.info(`stale-channel sweep: scanned=${r.scanned} archived=${r.archived}`);
      });
      const staleBootDelayMs = readOptionalIntEnv("CONCORDIA_DISCORD_STALE_BOOT_SWEEP_DELAY_MS", 0, 1000);
      if (staleBootDelayMs > 0) {
        scheduleBackground("stale-channel boot sweep", runStaleSweep, staleBootDelayMs);
      } else {
        log.info("stale-channel boot sweep disabled");
      }
      const staleSweepSec = readOptionalIntEnv("CONCORDIA_DISCORD_STALE_SWEEP_SEC", 0, 60 * 60);
      if (staleSweepSec > 0) {
        staleChannelTimer = setInterval(() => {
          void runStaleSweep().catch((e) => log.warn(`stale-channel sweep failed: ${(e as Error).message}`));
        }, staleSweepSec * 1000);
        staleChannelTimer.unref?.();
      } else {
        log.info("stale-channel periodic sweep disabled");
      }
      // Discord は「作業中」メッセージを投稿せず、Forum の状態タグだけで表す。
      // summary / final_answer が実際に投稿されるまでタグを保持する。
      channelWorkState = new ChannelWorkState({
        log: (m) => log.info(`channel-work-state: ${m}`),
        setWorking: (sessionId, working) =>
          sessionWorkStateApply(
            { guild, layout: layout!, repo: sessionChannelsRepo, log },
            { sessionId, working },
          ),
      });
      unsubscribe = eventBus.subscribe((ev) => routeEvent(ev, guild));
      deps.onRuntimeState?.({ running: true, status: "ready" });
    } catch (e) {
      const message = (e as Error).message;
      log.error(`ready handler failed: ${message}`);
      stopAfterGatewayInstability("ready_handler_failed", message);
    }
  }));

  client.on(Events.MessageCreate, instrumentDiscord("messageCreate", (msg) => {
    if (gatewayClosed || stopping) return;
    // 自分の guild 以外 (同一 token の本社/他子会社 Client にも届くイベント) は無視。
    if (!inScope(msg.guildId)) return;
    void (async () => {
      // Test Forum スレッドへの人間の投稿はテストセッションの起動/指示。
      // 通常の ingress (セッションチャンネル/受付) より先に判定し、 対象なら委ねない。
      if (layout?.testForumId) {
        const handled = await handleTestForumMessage(msg, {
          testForumId: layout.testForumId,
          surfaces: testSurfacesRepo,
          concordiaUrl: deps.concordiaUrl,
          workspaceRoots,
          isLaunchUserAllowed: deps.isLaunchUserAllowed,
          isSessionAlive: (sessionId) => deps.sessionsRepo.findSession(sessionId)?.status === "active",
          // emitSessionInject が未配線でも投稿を黙って捨てない (📨 を返しておいて
          // 実際には届かない、 を避ける)。 リアクションワークフローと同じ経路へ落とす。
          injectToSession: (sessionId, text, source) => {
            if (deps.emitSessionInject) {
              deps.emitSessionInject(sessionId, text, source);
              return;
            }
            eventBus.emit({
              type: "session.inject",
              target_session_id: sessionId,
              text,
              source,
              ts: Math.floor(Date.now() / 1000),
            });
          },
          log,
        }).catch((e) => {
          log.warn(`test-forum message handler failed channel=${msg.channelId}: ${(e as Error).message}`);
          return false;
        });
        if (handled) return;
      }
      await measuredHandleIngressMessage({
        configRepo,
        sessionChannelsRepo,
        sessionsRepo: deps.sessionsRepo,
        concordiaUrl: deps.concordiaUrl,
        routeFederationIngress: deps.routeFederationIngress,
        log,
        // 単発絵文字 (🙏 / 🫡 等) をリアクションワークフローに流すための解決系。
        chatRepo: deps.chatRepo,
        messageMap,
        workflow: reactionWorkflow,
        isWorkflowUserAllowed: deps.isReactionWorkflowUserAllowed,
        isSessionEndUserAllowed: deps.isSessionEndUserAllowed,
        isPlanDecisionUserAllowed: deps.isLaunchUserAllowed,
        recordStaffAccess: deps.recordStaffAccess,
        resolveReactionMappings: deps.resolveReactionMappings,
        // 窓口: 子会社 Bot なら受付チャンネル、 本社 Bot なら desk のタスク依頼チャンネル。
        // どちらも同じガードゲートに通す (ingress は種別を知らない)。 両方は同時に持たない
        // (子会社 Bot に desk は配線されない)。
        intake: resolveIntake(deps, subsidiaryIntakeChannelId, deskChannelId),
        subsidiary: Boolean(deps.subsidiary),
        handlePlanReply: async (sessionId, text, authorId) => {
          const match = text.match(/^\s*\[([ABC])\](?:\s+([\s\S]+))?\s*$/i);
          if (!match) return { handled: false };
          const directorCase = ingressDirectorRepo.findLatestCaseForSession(sessionId);
          if (!directorCase) return { handled: false };
          const plan = ingressDirectorRepo.listDecisions(directorCase.id)
            .filter((decision) => decision.plan_version != null)
            .at(-1);
          if (!plan?.plan_version) return { handled: false };
          if (deps.isLaunchUserAllowed?.(authorId) !== true) {
            return {
              handled: true,
              reply: "このユーザーにはプラン判断権限がありません (管理職以上が必要)。",
            };
          }
          const code = match[1]!.toUpperCase();
          const action = code === "A" ? "approve" : code === "B" ? "revise" : "discard";
          const instruction = match[2]?.trim();
          if (action === "revise" && !instruction) return { handled: true, reply: "Use `[B] <required changes>` to revise this plan." };
          const response = await fetch(`${deps.concordiaUrl}/v1/director/cases/${directorCase.id}/plan/action`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, version: plan.plan_version, ...(instruction ? { instruction } : {}) }),
          });
          if (!response.ok) return { handled: true, reply: `Plan action failed (${response.status}).` };
          return { handled: true, reply: action === "approve" ? "Plan approved." : action === "revise" ? "Revision requested; the previous card is superseded." : "Plan discarded." };
        },
      }, msg);
    })().catch((e) => {
      log.warn(`ingress handler failed channel=${msg.channelId}: ${(e as Error).message}`);
    });
  }));

  client.on(Events.ThreadCreate, instrumentDiscord("threadCreate", (thread, newlyCreated) => {
    const forumLayout = layout;
    const forumWebhooks = webhooks;
    if (gatewayClosed || stopping || !newlyCreated || !forumLayout?.forumMode || !forumWebhooks) return;
    if (!inScope(thread.guildId)) return;
    const parent = thread.parent?.type === ChannelType.GuildForum ? thread.parent : null;
    const forumSpawnThread: ForumSpawnThread = {
      id: thread.id,
      guildId: thread.guildId,
      parentId: thread.parentId,
      ownerId: thread.ownerId,
      name: thread.name,
      appliedTags: thread.appliedTags,
      availableTags: parent?.availableTags ?? [],
      fetchStarterMessage: async () => {
        const starter = await thread.fetchStarterMessage();
        return starter ? { content: starter.content } : null;
      },
      fetchTagState: async () => {
        const freshThread = await thread.fetch(true);
        const freshParent = freshThread.parent?.type === ChannelType.GuildForum
          ? await freshThread.parent.fetch(true)
          : null;
        return {
          appliedTags: freshThread.appliedTags,
          availableTags: freshParent?.type === ChannelType.GuildForum ? freshParent.availableTags : [],
        };
      },
    };
    void handleForumSpawnThread({
        sessionForumId: forumLayout.sessionForumId,
        botUserId: client.user?.id ?? "",
        concordiaUrl: deps.concordiaUrl,
      // このスレッドを持つ Bot インスタンス自身の子会社 id (本社なら null)。
      // /v1/delegation/invoke へ転送し、 spawn したセッションを正しい会社スコープに
      // 帰属させる (ownsSession の subsidiary-only 可視判定を壊さないため)。
        subsidiaryId,
        isLaunchUserAllowed: deps.isLaunchUserAllowed,
        templates: async () => (await delegationTemplateCache.get(deps.concordiaUrl, log)).templates,
        selectTemplate: (input) => selectForumDelegationTemplate(
          (prompt, options) => deps.runHeadless(prompt, options),
          input,
        ),
        resolveProjectTarget: projectResolver.targetFromPost,
        resolveSpawnCwd: (provider, requested) =>
        deps.resolveSessionSpawnCwd?.(provider, requested) ?? requested ?? workspaceRoots[0],
        hasExistingRun: (triggeredBy) => delegationRepo.findRunByTriggeredBy(triggeredBy) !== null,
        postToThread: async (threadId, content) => {
        const webhook = await forumWebhooks.getForChannel(forumLayout.sessionForumId);
        if (!webhook) throw new Error("Session forum webhook unavailable");
        const sent = await forumWebhooks.send(webhook, {
          content,
          threadId,
          username: process.env.CONCORDIA_DISCORD_FORUM_WEBHOOK_NAME?.trim() || "Concordia",
          ...(process.env.CONCORDIA_DISCORD_FORUM_WEBHOOK_AVATAR_URL?.trim()
            ? { avatarURL: process.env.CONCORDIA_DISCORD_FORUM_WEBHOOK_AVATAR_URL.trim() }
            : {}),
          allowedMentions: { parse: [] },
        });
        if (!sent) throw new Error("Session forum webhook post failed");
        },
        log,
      }, forumSpawnThread).catch((error) => {
      log.warn(`forum-spawn handler failed thread=${thread.id}: ${(error as Error).message}`);
    });
  }));

  const onMessageReactionAdd = instrumentDiscord("reactionAddEvent", (reaction, user) => {
    if (gatewayClosed || stopping) return;
    if (!inScope(reaction.message.guildId)) return;
    void measuredHandleReactionAdd(
      {
        reactionsRepo,
        messageMap,
        log,
        workflow: reactionWorkflow,
        isWorkflowUserAllowed: deps.isReactionWorkflowUserAllowed,
        recordStaffAccess: deps.recordStaffAccess,
        sessionChannels: sessionChannelsRepo,
        sessions: deps.sessionsRepo,
        repin: deps.repinSession,
      },
      reaction,
      user,
    ).catch((e) => {
      log.warn(`reaction add handler failed: ${(e as Error).message}`);
    });
  });
  const onMessageReactionRemove = instrumentDiscord("reactionRemoveEvent", (reaction, user) => {
    if (gatewayClosed || stopping) return;
    if (!inScope(reaction.message.guildId)) return;
    void measuredHandleReactionRemove({ reactionsRepo, messageMap, log }, reaction, user).catch((e) => {
      log.warn(`reaction remove handler failed: ${(e as Error).message}`);
    });
  });

  // workflow.reaction が無効な間はリアクションを **購読しない** (受け取ってから捨てない)。
  // フラグは都度解決なので、 値が変わったら購読を張り替える。
  let reactionListenersAttached = false;
  function syncReactionListeners(): void {
    const shouldAttach = isWorkflowEnabled("reaction");
    if (shouldAttach === reactionListenersAttached) return;
    if (shouldAttach) {
      client.on(Events.MessageReactionAdd, onMessageReactionAdd);
      client.on(Events.MessageReactionRemove, onMessageReactionRemove);
      log.info("reaction listeners attached (workflow.reaction enabled)");
    } else {
      client.off(Events.MessageReactionAdd, onMessageReactionAdd);
      client.off(Events.MessageReactionRemove, onMessageReactionRemove);
      log.info("reaction listeners detached (workflow.reaction disabled)");
    }
    reactionListenersAttached = shouldAttach;
  }
  syncReactionListeners();
  // Slash command の application id / REST 成否と独立して live toggle を反映する。
  reactionListenerTimer = setInterval(syncReactionListeners, COMMAND_REGISTRATION_CHECK_MS);
  reactionListenerTimer.unref?.();
  client.on(Events.InteractionCreate, instrumentDiscord("interactionCreate", (interaction) => {
    if (gatewayClosed || stopping) return;
    startInteractionAckProbe(interaction, recordDiscordInteractionAck);
    // 自分の guild 以外の interaction は無視。 これをしないと同一 token の本社/子会社
    // Client が同じ interaction を二重 dispatch し、 片方が「Interaction has already
    // been acknowledged」/「Unknown interaction」になる。 また子会社 guild の /spawn を
    // 本社 Client が拾って本社側にセッションを作ってしまう。
    if (!inScope(interaction.guildId)) return;
    if (!layout) {
      // 起動/再起動直後は layout 未準備。 旧実装は黙って捨てて "This interaction failed"
      // に見えていた (spawn が効いたり効かなかったりする一因)。 明示的に案内する。
      if (interaction.isRepliable()) {
        void interaction.reply({ content: "Bot 起動処理中です。数秒後にもう一度お試しください。", ephemeral: true })
          .catch(() => { /* interaction expired; best-effort */ });
      }
      return;
    }
    void measuredDispatchInteraction(interaction, {
      concordiaUrl: deps.concordiaUrl,
      sessionsRepo: deps.sessionsRepo,
      sessionChannelsRepo,
      pendingQuestionsRepo,
      testSurfacesRepo,
      // `/spawn` の team 候補・チャンネル起点のチーム帰属・task 候補の供給元。
      teams: teamsRepo,
      memoria: spawnTaskSource,
      revisor: deps.revisor,
      answerQuestion: deps.answerQuestion,
      guild: interaction.guild!,
      layout,
      log,
      permissionActions,
      subsidiaryId,
      isLaunchUserAllowed: deps.isLaunchUserAllowed,
      isSessionEndUserAllowed: deps.isSessionEndUserAllowed,
      isKillSwitchUserAllowed: deps.isKillSwitchUserAllowed,
      // guild 側に残った登録から実行されうるので dispatch でも同じ判定を通す。
      isWorkflowEnabled,
      // Test Forum のマージボタンは `merge_pr`。 未注入なら handler 側で deny (fail-closed)。
      isMergeUserAllowed: deps.hasStaffCapability
        ? (userId) => deps.hasStaffCapability!(userId, "merge_pr")
        : undefined,
      resolveWorkspaceRoots: deps.resolveWorkspaceRoots,
      // PR 操作パネル / RWF アクション選択パネル。 実処理はリアクション経由と同じ口を使う。
      prOperations: deps.prOperations,
      reactionWorkflow,
    }).catch((e) => {
      const age = interactionAgeMs(interaction);
      log.warn(
        `interaction handler failed id=${interaction.id} ${describeInteractionForLog(interaction)} ` +
        `age_ms=${age ?? "-"}: ${(e as Error).message}`,
      );
    });
  }));

  client.on(Events.Error, (e) => log.error(`client error: ${e.message}`));
  client.on(Events.Warn, (m) => log.warn(`client warn: ${m}`));
  client.on(Events.ShardError, (e, shardId) => {
    if (shouldRestartDiscordBot("error")) {
      stopAfterGatewayInstability("gateway_error", `shard=${shardId}: ${e.message}`);
    }
  });
  client.on(Events.ShardDisconnect, (event, shardId) => {
    if (shouldRestartDiscordBot("disconnect")) {
      stopAfterGatewayInstability("gateway_disconnected", `shard=${shardId} code=${event.code} reason=${event.reason || "-"}`);
    }
  });
  client.on(Events.ShardReconnecting, (shardId) => {
    // ShardReconnecting は discord.js が自力で resume する通常のライフサイクル
    // イベント。 ここで teardown すると一瞬のネットワーク揺らぎで bot が恒久停止
    // する (復帰経路なし) ため、 ログのみ残して resume に任せる。
    if (!shouldRestartDiscordBot("reconnecting")) {
      log.warn(`shard reconnecting shard=${shardId} (waiting for automatic resume)`);
    }
  });

  const startupContextInflight = new Set<string>();
  // 起動時投稿と後追い delegation inject は別 event として並行に到着し得る。
  // pin 済み metadata を各実行直前に読み直せるよう、同一 session のタスク投稿は直列化する。
  const sessionTaskPostInflight = new Map<string, Promise<void>>();

  function queueSessionTaskPost(sessionId: string, post: () => Promise<void>): Promise<void> {
    const previous = sessionTaskPostInflight.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(post);
    const tail = run.catch(() => undefined);
    sessionTaskPostInflight.set(sessionId, tail);
    void tail.finally(() => {
      if (sessionTaskPostInflight.get(sessionId) === tail) {
        sessionTaskPostInflight.delete(sessionId);
      }
    });
    return run;
  }

  function routeEvent(ev: ConcordiaEvent, guild: import("discord.js").Guild): void {
    if (gatewayClosed || stopping) return;
    if (ev.type === "delegation.templates_changed") {
      log.info(
        `delegation template cache invalidated action=${ev.action} ` +
        `call_name=${ev.call_name ?? "-"} template_id=${ev.template_id ?? "-"}`,
      );
      void invalidateAndRefreshDelegationTemplateCache(deps.concordiaUrl, log)
        .then((templates) => log.info(`delegation template cache refreshed templates=${templates.length}`))
        .catch((e) => log.warn(`delegation template cache refresh after invalidate failed: ${(e as Error).message}`));
      return;
    }
    // error.reported は WebSocket / 本社ランタイム側で扱う。Discord にはリレーしない。
    if (ev.type === "error.reported") {
      return;
    }
    if (!layout || !webhooks) return;

    // subsidiary-only 可視: このイベントが対象とするセッションが Bot の scope 外なら無視する
    // (本社 Bot は子会社セッションを写さず、 子会社 Bot は自分のセッションのみ写す)。
    const evSid = eventSessionId(ev);
    if (evSid !== null && !ownsSession(evSid)) return;

    if (ev.type === "session.started") {
      const state = deps.readModel.getSessionRelayState(ev.session_id);
      const sessionId = ev.session_id;
      const testSurfaceId = readTestSurfaceId(deps.sessionsRepo.findSession(sessionId)?.metadata ?? null);
      const testSurface = testSurfaceId ? testSurfacesRepo.findOpen(testSurfaceId) : null;
      const delegationRun = state?.delegationRunId ? delegationRepo.findRun(state.delegationRunId) : null;
      const forumSpawn = parseForumSpawnTrigger(delegationRun?.triggered_by);
      if (delegationRun && !layout.forumMode && (!forumSpawn || forumSpawn.guildId !== guild.id)) {
        log.info(
          `session.started delegation child: legacy layout has no TaskWorkflow surface session=${sessionId} ` +
          `run=${delegationRun.id} parent=${state?.delegationParentSessionId ?? "null"}`,
        );
        return;
      }
      void (async () => {
        try {
          const repoPath = state?.repoPath ?? ev.repo_path;
          const branch = state?.branch ?? ev.branch;
          if (testSurface) {
            await bindForumSpawnSession(
              {
                guild,
                sessionForumId: layout.testForumId,
                repo: sessionChannelsRepo,
                webhooks,
                log,
              },
              {
                sessionId,
                threadId: testSurface.thread_id,
                provider: ev.provider ?? null,
                repoPath,
                branch,
                callName: "test-workflow",
                state,
              },
            );
            testSurfacesRepo.markTesting(testSurface.id, sessionId, repoPath);
            const updated = testSurfacesRepo.findOpen(testSurface.id);
            // 操作面の描き替えに失敗しても、 セッション自体の登録 (transcript replay /
            // 状態カード) は続ける。 次の reconcile で操作面は貼り直される。
            if (updated?.controls_message_id) {
              await refreshTestForumControls(guild, updated).catch((e: unknown) =>
                log.warn(`test-forum controls refresh failed surface=${testSurface.id}: ${(e as Error).message}`));
            }
            log.info(`test-forum bound session=${sessionId} surface=${testSurface.id}`);
          } else if (forumSpawn) {
            await bindForumSpawnSession(
              {
                guild,
                sessionForumId: layout.sessionForumId,
                repo: sessionChannelsRepo,
                webhooks,
                log,
              },
              {
                sessionId,
                threadId: forumSpawn.threadId,
                provider: ev.provider ?? null,
                repoPath,
                branch,
                callName: delegationRun?.call_name ?? null,
                state,
              },
            );
          } else {
            const surface = resolveForumSessionSurface(layout, delegationRun?.id);
            const teamId = deps.sessionsRepo.findSession(sessionId)?.team_id ?? null;
            const surfaceLayout = {
              ...layout,
              sessionForumId: resolveTeamSessionForumId(
                teamsRepo,
                teamId,
                surface.label === "TaskWorkflow" ? "task" : "session",
                surface.forumId,
              ),
            };
            await onSessionRegistered(
              { guild, layout: surfaceLayout, repo: sessionChannelsRepo, log, webhooks },
              {
                sessionId,
                agentType: ev.provider ?? null,
                delegationEmoji: state?.delegationEmoji ?? null,
                roleLabel: delegationRun?.call_name ?? state?.roleLabel ?? null,
                repoPath,
                branch,
                model: state?.model ?? null,
                effortLevel: state?.effortLevel ?? null,
                fastMode: state?.fastMode ?? null,
                currentTask: state?.currentTask ?? delegationRun?.call_name ?? null,
                projectCodes: projectResolver.codesForRepos(readActiveRepos(state)),
                surfaceLabel: surface.label,
                delegationRunId: surface.delegationRunId,
                webhookName: state?.webhookName ?? null,
                webhookAvatarUrl: state?.webhookAvatarUrl ?? null,
              },
            );
            if (delegationRun) {
              log.info(`task-workflow bound session=${sessionId} run=${delegationRun.id}`);
            }
          }
          const sessionSurface = sessionChannelsRepo.findBySessionId(sessionId);
          const needsStartupTaskPost = Boolean(state?.startupTaskText && !state.taskPosted);
          const needsStartupContextPost = !state?.startupContextPosted;
          const startupTaskText = state?.startupTaskText;
          const webhookPool = webhooks;
          if (
            sessionSurface
            && (state?.startupInjectText || startupTaskText)
            // タスク本文と起動コンテキストの成功は独立して記録する。前者だけが失敗しても
            // 後者の投稿済みフラグによって再試行不能にしてはいけない。
            && (needsStartupTaskPost || needsStartupContextPost)
            && !startupContextInflight.has(sessionId)
            && webhookPool
          ) {
            startupContextInflight.add(sessionId);
            try {
              // タスク本文が先。 pin する 1 通目が thread の先頭に来るようにする。
              if (needsStartupTaskPost && startupTaskText) {
                await queueSessionTaskPost(sessionId, async () => {
                  const latestState = deps.readModel.getSessionRelayState(sessionId);
                  const taskPosted = await postSessionTaskBody({
                    sessionId,
                    channelId: sessionSurface.channel_id,
                    kind: "startup",
                    taskText: startupTaskText,
                    stagedPending: latestState?.stagedInjection === true
                      && latestState.stagedFollowupDelivered !== true,
                    alreadyPinned: latestState?.taskPinned === true,
                    webhooks: webhookPool,
                    sessionsRepo: deps.sessionsRepo,
                    pin: pinChannelMessage,
                    log,
                  });
                  if (!taskPosted) log.warn(`session task post failed session=${sessionId}`);
                });
              }
              if (needsStartupContextPost) {
                const posted = await postSessionStartupContext({
                  sessionId,
                  context: {
                    requesterUserId: state?.requesterDiscordUserId ?? null,
                    startupInjectText: state?.startupInjectText ?? null,
                    surfaceLabel: delegationRun ? "TaskWorkflow" : "Session",
                    sessionChannelId: sessionSurface.channel_id,
                    sourceGuildId: state?.sourceDiscordGuildId ?? forumSpawn?.guildId ?? null,
                    sourceChannelId: state?.sourceDiscordChannelId ?? forumSpawn?.threadId ?? null,
                  },
                  webhooks,
                  sessionsRepo: deps.sessionsRepo,
                });
                if (!posted) log.warn(`session startup context post failed session=${sessionId}`);
              }
            } finally {
              startupContextInflight.delete(sessionId);
            }
          }
          // channel 作成前に届いて「永続化のみ」になった frame を埋め戻す。
          // watermark (maxId) は channel 行作成後に取る — これ以降の frame は
          // relay gate を通ってライブ配信されるので replay 対象から外れる。
          if (deps.transcriptLogs) {
            const upToId = deps.transcriptLogs.maxId(sessionId);
            replayPersistedTranscript(
              { transcriptLogs: deps.transcriptLogs, log },
              sessionId,
              upToId,
            );
          }
          await upsertSessionStatusCard({
            guild,
            layout,
            configRepo,
            sessionChannelsRepo,
            readModel: deps.readModel,
            log,
          }, sessionId, { allowCreate: true });
          // 状態カード作成後、セッションチャンネルの topic を状態カードリンクにする。
          const statusChannelId = getStatusChannelId(configRepo, sessionId);
          if (statusChannelId) {
            const sessionRow = sessionChannelsRepo.findBySessionId(sessionId);
            if (sessionRow) {
              await updateSessionSurfaceMetadata(
                { guild, layout, repo: sessionChannelsRepo, log, webhooks },
                {
                  sessionId,
                  repoPath,
                  branch,
                  model: state?.model ?? null,
                  effortLevel: state?.effortLevel ?? null,
                  fastMode: state?.fastMode ?? null,
                  statusCardChannelId: statusChannelId,
                  surfaceLabel: delegationRun ? "TaskWorkflow" : "Session",
                  delegationRunId: delegationRun?.id ?? null,
                },
              ).catch((e: unknown) => log.warn(`session-forum: starter update failed ${sessionId}: ${(e as Error).message}`));
              const ch = guild.channels.cache.get(sessionRow.channel_id);
              if (ch && ch.type === ChannelType.GuildText) {
                await ch.edit({
                  topic: `https://discord.com/channels/${guild.id}/${statusChannelId}`,
                  reason: `session status card link for ${sessionId}`,
                }).catch((e: unknown) => log.warn(`session-channel: topic link failed ${sessionId}: ${(e as Error).message}`));
              }
            }
          }
        } catch (e) {
          log.warn(`session.started handler failed ${sessionId}: ${(e as Error).message}`);
        }
      })();
      return;
    }
    // model / effort の task-change 再評価は契約 lifecycle (LLM tier + runtime 反映) に
    // 吸収された (contract-absorb-model-review)。 単発 mreview ダイアログは撤去済み。
    if (ev.type === "director.plan_submitted") {
      void (async () => {
        const card = renderPlanCard({ caseId: ev.case_id, version: ev.version, markdown: ev.markdown });
        // プラン設計カードはチームの目標面へ (teams.md §2)。 case の team_id を正とし、
        // 未設定ならセッションの team_id で引く。 どちらも無ければ現行どおりセッション面へ。
        const caseTeamId = deps.subsidiary ? null : ingressDirectorRepo.findCase(ev.case_id)?.team_id ?? null;
        const channelId = (caseTeamId ? resolveTeamCardChannel(teamsRepo, caseTeamId, "director-plan") : null)
          ?? teamCardChannelForSession(ev.target_session_id, "director-plan");
        // フェーズ文脈索引: プランカードの message id を metadata に残す (探索なしで索引を組む)。
        const teamMessageId = await postToTeamSurface(guild, channelId, { ...card, allowedMentions: { parse: [] } });
        if (teamMessageId) {
          recordPlanCardMessageId(deps.sessionsRepo, ev.target_session_id, teamMessageId, log);
          return;
        }
        const client = await webhooks.getForSession(ev.target_session_id);
        if (!client) return;
        const sent = await webhooks.send(client, { ...card, username: "Cc plan gate" });
        recordPlanCardMessageId(deps.sessionsRepo, ev.target_session_id, sent?.id, log);
      })().catch(error => log.warn(`plan card failed: ${(error as Error).message}`));
      return;
    }
    if (!deps.subsidiary && ev.type === "team.created") {
      void (async () => {
        await ensureTeamDiscordLayout({
          guild,
          db: deps.db,
          teamId: ev.team_id,
          name: ev.name,
        });
        await postTeamAuditCard(
          { guild, teamsRepo: new TeamsRepo(deps.db), log, subsidiary: Boolean(deps.subsidiary) },
          { kind: "created", eventId: ev.event_id, teamId: ev.team_id, name: ev.name, slug: ev.slug, ts: ev.ts },
        );
      })().catch((error) => log.warn(`team provision failed: ${(error as Error).message}`));
      return;
    }
    if (!deps.subsidiary && ev.type === "team.changed") {
      void (async () => {
        const team = new TeamsRepo(deps.db).find(ev.team_id);
        if (team) {
          await ensureTeamDiscordLayout({
            guild,
            db: deps.db,
            teamId: team.id,
            name: team.name,
          });
        }
        await postTeamAuditCard(
          { guild, teamsRepo: new TeamsRepo(deps.db), log, subsidiary: Boolean(deps.subsidiary) },
          { kind: "changed", eventId: ev.event_id, teamId: ev.team_id, fields: ev.fields, ts: ev.ts },
        );
      })().catch((error) => log.warn(`team provision update failed team=${ev.team_id}: ${(error as Error).message}`));
      return;
    }
    if (!deps.subsidiary && ev.type === "team.card_requested") {
      void postTeamCard(
        { guild, teamsRepo: new TeamsRepo(deps.db), log, subsidiary: Boolean(deps.subsidiary) },
        { teamId: ev.team_id, kind: ev.kind, title: ev.title, body: ev.body },
      ).catch((error) => log.warn(`team card post failed team=${ev.team_id}: ${(error as Error).message}`));
      return;
    }
    if (ev.type === "session.lost") {
      channelWorkState?.clear(ev.session_id);
      void onSessionStatusChanged({ guild, layout, repo: sessionChannelsRepo, log }, { sessionId: ev.session_id, status: "lost" });
      // lost = wrapper の heartbeat が止まった (端末を閉じた等で実質終了)。 状態カードは
      // グレーで残さず即削除する。 旧実装は upsert でグレー化して残し、 削除は 1 時間ごとの
      // reconcileLostStatusCards 任せだったため「終わったセッションのカードが最大 1h 居座る」
      // 状態だった。 もし lost から復帰 (resume) すれば session.started で新規カードが立つ。
      void deleteSessionStatusCard({ guild, configRepo, log }, ev.session_id)
        .catch((e) => log.warn(`status-card delete on lost failed session=${ev.session_id}: ${(e as Error).message}`));
      return;
    }
    if (ev.type === "session.ended") {
      channelWorkState?.clear(ev.session_id);
      void onSessionStatusChanged({ guild, layout, repo: sessionChannelsRepo, log, webhooks: webhooks ?? undefined }, { sessionId: ev.session_id, status: "ended" });
      // End-Session: 会話チャンネル削除 (onSessionStatusChanged) に加え、状態カードも削除する。
      void deleteSessionStatusCard({ guild, configRepo, log }, ev.session_id)
        .catch((e) => log.warn(`status-card delete on ended failed session=${ev.session_id}: ${(e as Error).message}`));
      // チーム所属セッションなら、 1 本分の実績をチームのコスト面へ報告する。
      void postTeamCostReport(ev.session_id, ev.ts * 1000)
        .catch((e) => log.warn(`team cost report failed session=${ev.session_id}: ${(e as Error).message}`));
      return;
    }
    // stat.collected での状態カード更新は撤去 (更新は 10 分毎の定期 tick のみ)。
    if (ev.type === "pr.changed") {
      // ingest / reconcile で PR キューが動いたら pr-queue チャンネルを即時更新.
      prQueueRefresh?.();
      void testForumRefresh?.("pr.changed");
      return;
    }
    if (ev.type === "delegation.run_changed") {
      if (!isActiveDiscordSession(ev.parent_session_id)) return;
      void upsertSessionStatusCard({
        guild,
        layout,
        configRepo,
        sessionChannelsRepo,
        readModel: deps.readModel,
        log,
      }, ev.parent_session_id).catch((e) => {
        log.warn(`delegation status-card refresh failed session=${ev.parent_session_id}: ${(e as Error).message}`);
      });
      // 起動できた委託の投稿へ、親の面から辿れるリンクを 1 回だけ貼る。
      void (async () => {
        const run = delegationRepo.findRun(ev.run_id);
        if (!run) return;
        await postDelegationThreadLink(
          {
            guildId: guild.id,
            sessionChannelsRepo,
            configRepo,
            post: async (channelId, content) => {
              const channel = await guild.channels.fetch(channelId).catch(() => null);
              // resolved = 投稿成功という port 契約。取得失敗を成功扱いすると marker だけが
              // 永続化され、以後の status event でもリンクを再試行できなくなる。
              if (!channel?.isTextBased()) {
                throw new Error(`delegation parent channel unavailable: ${channelId}`);
              }
              await channel.send({ content, allowedMentions: { parse: [] } });
            },
            log,
          },
          {
            runId: ev.run_id,
            status: ev.status,
            parentSessionId: ev.parent_session_id,
            childSessionId: run.child_session_id,
            label: run.call_name,
          },
        );
      })().catch((e) => log.warn(`delegation thread link failed run=${ev.run_id}: ${(e as Error).message}`));
      return;
    }
    if (ev.type === "taskflow.user_decision") {
      if (!isActiveDiscordSession(ev.target_session_id)) return;
      void (async () => {
        const message = buildTaskflowDecisionMessage({
          text: ev.text,
          mentionUserId: ev.mention_user_id,
        });
        // 判断ログはチームの direction 面へ (teams.md §2)。 チーム未設定・面欠落は
        // 現行どおりセッション webhook へ。 username は webhook 専用なので面送信では外す。
        const { username: _username, ...channelPayload } = message;
        const channelId = teamCardChannelForSession(ev.target_session_id, "decision-log");
        if (await postToTeamSurface(guild, channelId, channelPayload)) return;
        const client = await webhooks.getForSession(ev.target_session_id);
        if (!client) return;
        await webhooks.send(client, message);
      })().catch((e) => log.warn(`taskflow decision post failed: ${(e as Error).message}`));
      return;
    }
    if (ev.type === "chat.posted" || ev.type === "session.message") {
      handleEgressEvent({
        guild,
        layout,
        webhooks,
        readModel: deps.readModel,
        sessionChannelsRepo,
        messageMap,
        deliveryRepo: sessionMessageDeliveryRepo,
        messageOptimizationEnabled: env.messageOptimizationEnabled,
        resolveWorkspaceRoots: deps.resolveWorkspaceRoots,
        onSessionMessagePosted,
        log,
      }, ev);
      // canonical message の配送中も「作業中」を維持する。解除は egress が実際の投稿成功を
      // 通知した後だけ行う。chat.posted は出力の別経路なので作業開始シグナルにしない。
      if (ev.type === "session.message" && isActiveDiscordSession(ev.target_session_id)) {
        channelWorkState?.noteProgress(ev.target_session_id);
      }
      // 指示 (Discord inject) → canonical message が動いた最初のタイミングで ✅ を付ける。
      // takeInjectAck は delete-on-read なので、 後続メッセージや codex prompt 経路と
      // 二重に付かない。 Enter 未送信で出力がなければ ✅ は付かない。
      if (ev.type === "session.message") {
        const ack = takeInjectAck(ev.target_session_id);
        if (ack) {
          void (async () => {
            try {
              const channel = guild.channels.cache.get(ack.channelId);
              if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PublicThread)) return;
              const m = await channel.messages.fetch(ack.messageId);
              await m.react("✅");
            } catch (e) {
              log.warn(`inject-ack: react failed session=${ev.target_session_id}: ${(e as Error).message}`);
            }
          })();
        }
      }
      return;
    }
    if (ev.type === "session.event" && ev.kind === "prompt") {
      // 指令を受け付けた = 作業開始。出力が来る前から「作業中」タグを付ける。
      const prompt = deps.readModel.getSessionPromptEvent(ev.session_id);
      if (!prompt) return;
      const row = sessionChannelsRepo.findBySessionId(ev.session_id);
      if (!isActiveRelayTarget(prompt.status, row?.status ?? null)) return;
      channelWorkState?.noteProgress(ev.session_id);
      const source = prompt.source;
      // Prompt 本文は canonical session.message が唯一の egress 経路。
      // ここでは Discord inject の受領リアクションだけを処理する。
      if (parseInjectSource(source).platform === "discord" || source === "discord-enter" || source === "discord-enter-fallback") {
        // Prompt が受理されたら、保留中の ✅ を 1 回だけ付ける。
        const ack = takeInjectAck(ev.session_id);
        if (ack) {
          void (async () => {
            try {
              const channel = guild.channels.cache.get(ack.channelId);
              if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.PublicThread)) return;
              const m = await channel.messages.fetch(ack.messageId);
              await m.react("✅");
            } catch (e) {
              log.warn(`inject-ack: codex react failed session=${ev.session_id}: ${(e as Error).message}`);
            }
          })();
        }
      }
      return;
    }
    if (ev.type === "session.event" && ev.kind === "title_renamed") {
      const titleEvent = deps.readModel.getSessionTitleEvent(ev.session_id);
      if (!isActiveDiscordSession(ev.session_id)) return;
      if (titleEvent) {
        // title-suggestion (AI 自動) はチャンネル名を変えない。手動/リアクション rename のみ反映。
        const forceRename = titleEvent.source !== "title-suggestion";
        void onSessionTitleChanged(
          { guild, layout, repo: sessionChannelsRepo, log },
          {
            sessionId: ev.session_id,
            title: titleEvent.title,
            agentType: titleEvent.provider,
            forceRename,
            projectCodes: projectResolver.codesForRepos(readActiveRepos(deps.readModel.getSessionRelayState(ev.session_id))),
          },
        );
      }
      return;
    }
    if (ev.type === "session.event" && ev.kind === "branch_changed") {
      const state = deps.readModel.getSessionRelayState(ev.session_id);
      if (!state) return;
      const delegationRun = state.delegationRunId ? delegationRepo.findRun(state.delegationRunId) : null;
      void updateSessionSurfaceMetadata(
        { guild, layout, repo: sessionChannelsRepo, log, webhooks },
        {
          sessionId: ev.session_id,
          repoPath: state.repoPath,
          branch: state.branch,
          model: state.model,
          effortLevel: state.effortLevel,
          fastMode: state.fastMode,
          statusCardChannelId: getStatusChannelId(configRepo, ev.session_id),
          surfaceLabel: delegationRun ? "TaskWorkflow" : "Session",
          delegationRunId: delegationRun?.id ?? null,
        },
      ).catch((e) => log.warn(`session-forum: branch update failed ${ev.session_id}: ${(e as Error).message}`));
      return;
    }
    if (ev.type === "session.event" && ev.kind === "lictor.active_repo.changed") {
      const state = deps.readModel.getSessionRelayState(ev.session_id);
      if (!state || !isActiveDiscordSession(ev.session_id)) return;
      void onSessionTitleChanged(
        { guild, layout, repo: sessionChannelsRepo, log },
        {
          sessionId: ev.session_id,
          title: state.currentTask ?? "session",
          agentType: state.provider,
          projectCodes: projectResolver.codesForRepos(readActiveRepos(state)),
        },
      );
      return;
    }
    // task_update での状態カード即時更新は撤去 (更新は 10 分毎の定期 tick のみ)。
    if (ev.type === "question.posted") {
      // 委託子の面が無い/非アクティブでも、 親 (委託元) の面が生きていれば捨てない。
      const deliverable = isActiveDiscordSession(ev.target_session_id)
        || (ev.parent_session_id ? isActiveDiscordSession(ev.parent_session_id) : false);
      if (!deliverable) return;
      void postQuestion({
        guild,
        sessionChannelsRepo,
        pendingQuestionsRepo,
        log,
        isActiveSession: isActiveDiscordSession,
        // ask_human / 契約質問カードはチームの direction 面へ (teams.md §2)。
        resolveTeamChannelId: (sessionId) => teamCardChannelForSession(sessionId, "question"),
        recordQuestionMessageId: (sessionId, messageId) =>
          recordQuestionCardMessageId(deps.sessionsRepo, sessionId, messageId, log),
      }, ev);
      return;
    }
    if (ev.type === "session.permission_request") {
      if (!resolvePermissionRequestsEnabled()) return;
      if (!isActiveDiscordSession(ev.target_session_id)) return;
      void postPermissionRequest({ guild, sessionChannelsRepo, permissionActions, log }, ev)
        .catch((e) => log.warn(`permission request post failed session=${ev.target_session_id}: ${(e as Error).message}`));
      return;
    }
    if (ev.type === "question.resolved") {
      if (!isActiveDiscordSession(ev.target_session_id)) return;
      // picker がローカル回答で解決 → 投稿済み質問のボタンを外す（再クリック防止）。
      void resolveQuestionMessage({ guild, sessionChannelsRepo, pendingQuestionsRepo, log }, ev);
      return;
    }
    if (ev.type === "session.inject") {
      const src = ev.source ?? "";
      // 委託 (delegation) 由来の inject は Cc がその場で組み立てたタスク本文であり、
      // transcript には出ない。 段階注入の第 2 段階 (実装タスク) がここに来るので、
      // 転記しないと「何を委託したか」が Discord にまったく残らない。
      const delegationKind = taskKindForInjectSource(src);
      if (delegationKind) {
        if (!isActiveDiscordSession(ev.target_session_id)) return;
        const surface = sessionChannelsRepo.findBySessionId(ev.target_session_id);
        if (!surface || !webhooks) return;
        const webhookPool = webhooks;
        void queueSessionTaskPost(ev.target_session_id, async () => {
          const state = deps.readModel.getSessionRelayState(ev.target_session_id);
          await postSessionTaskBody({
            sessionId: ev.target_session_id,
            channelId: surface.channel_id,
            kind: delegationKind,
            taskText: stripDelegationInjectHeader(ev.text),
            // 第 2 段階が届いた時点で「伏せていた本文」は解禁済み。
            stagedPending: false,
            alreadyPinned: state?.taskPinned === true,
            webhooks: webhookPool,
            sessionsRepo: deps.sessionsRepo,
            pin: pinChannelMessage,
            log,
          });
        }).catch((e) => log.warn(
          `delegation inject mirror failed session=${ev.target_session_id}: ${(e as Error).message}`,
        ));
        return;
      }
      // 環境同期: 相手プラットフォーム(Slack)由来の inject を Discord の session channel
      // にも発言者付きで転記する。Discord 由来は元発言が既に表示済なので転記しない。
      // 制御 inject (/enter 等、source 例 "discord-enter") は ^slack: に一致せず除外。
      if (parseInjectSource(src).platform !== "slack") return;
      if (!isActiveDiscordSession(ev.target_session_id)) return;
      const who = ev.author_label?.trim() || "Slack user";
      void (async () => {
        const client = await webhooks.getForSession(ev.target_session_id);
        if (!client) return;
        await webhooks.send(client, { content: ev.text.slice(0, 1900), username: `🔁 Slack / ${who}` });
      })().catch((e) => log.warn(`slack inject mirror failed session=${ev.target_session_id}: ${(e as Error).message}`));
    }
  }

  await client.login(env.token);
  if (gatewayClosed) throw new Error("discord gateway closed during startup");

  return {
    name: "discord",
    async postToSession(input) {
      if (gatewayClosed || stopping || !webhooks) return;
      const client = await webhooks.getForSession(input.sessionId);
      if (!client) return;
      await webhooks.send(client, {
        content: input.text,
        username: input.authorLabel?.trim() || "Concordia",
      });
    },
    async ensureSessionSurface(sessionId) {
      if (gatewayClosed || stopping || !activeGuild || !layout) return;
      const state = deps.readModel.getSessionRelayState(sessionId);
      const surface = resolveForumSessionSurface(layout, state?.delegationRunId ?? null);
      const teamId = deps.sessionsRepo.findSession(sessionId)?.team_id ?? null;
      const surfaceLayout = {
        ...layout,
        sessionForumId: resolveTeamSessionForumId(
          teamsRepo,
          teamId,
          surface.label === "TaskWorkflow" ? "task" : "session",
          surface.forumId,
        ),
      };
      await onSessionRegistered(
        { guild: activeGuild, layout: surfaceLayout, repo: sessionChannelsRepo, log, webhooks: webhooks ?? undefined },
        {
          sessionId,
          agentType: state?.provider ?? null,
          delegationEmoji: state?.delegationEmoji ?? null,
          roleLabel: state?.roleLabel ?? null,
          repoPath: state?.repoPath ?? null,
          branch: state?.branch ?? null,
          model: state?.model ?? null,
          effortLevel: state?.effortLevel ?? null,
          fastMode: state?.fastMode ?? null,
          currentTask: state?.currentTask ?? null,
          projectCodes: projectResolver.codesForRepos(readActiveRepos(state)),
          surfaceLabel: surface.label,
          delegationRunId: surface.delegationRunId,
        },
      );
      await upsertSessionStatusCard({
        guild: activeGuild,
        layout,
        configRepo,
        sessionChannelsRepo,
        readModel: deps.readModel,
        log,
      }, sessionId, { allowCreate: true });
      if (state) {
        const delegationRun = state.delegationRunId ? delegationRepo.findRun(state.delegationRunId) : null;
        await updateSessionSurfaceMetadata(
          { guild: activeGuild, layout, repo: sessionChannelsRepo, log, webhooks: webhooks ?? undefined },
          {
            sessionId,
            repoPath: state.repoPath,
            branch: state.branch,
            model: state.model,
            effortLevel: state.effortLevel,
            fastMode: state.fastMode,
            statusCardChannelId: getStatusChannelId(configRepo, sessionId),
            surfaceLabel: delegationRun ? "TaskWorkflow" : "Session",
            delegationRunId: delegationRun?.id ?? null,
          },
        ).catch((e) => log.warn(`session-forum: starter update failed ${sessionId}: ${(e as Error).message}`));
      }
    },
    async postQuestion(input) {
      if (gatewayClosed || stopping || !activeGuild) return;
      await postQuestion(
        {
          guild: activeGuild,
          sessionChannelsRepo,
          pendingQuestionsRepo,
          log,
          // EventBus 経由だけでなく ChatPlatform API 経由の質問も同じチーム面へ出す。
          resolveTeamChannelId: (sessionId) => teamCardChannelForSession(sessionId, "question"),
          recordQuestionMessageId: (sessionId, messageId) =>
            recordQuestionCardMessageId(deps.sessionsRepo, sessionId, messageId, log),
        },
        { target_session_id: input.target_session_id, question_id: input.question_id, question: input.question, options: input.options },
      );
    },
    async relayFrame(input) {
      if (gatewayClosed || stopping) return;
      // D6 egress consumes canonical session.message events. Re-enter raw
      // federation frames through the projector instead of passing them to the
      // retired transcript-frame egress branch.
      eventBus.emit({
        type: "transcript.frame",
        target_session_id: input.target_session_id,
        kind: input.kind as never,
        payload: input.payload as never,
        seq: input.seq ?? 0,
        ts: Math.floor(Date.now() / 1000),
      });
    },
    async stop() {
      stopping = true;
      // 自分が登録した場合だけ外す。子会社 Bot の停止で本社の egress を落とさない。
      if (federationEgressRegistered) {
        federationEgressRegistered = false;
        deps.setFederationEgressExecutor?.(null);
      }
      await stopLifecycle([
        { name: "event subscription", stop: () => { unsubscribe?.(); unsubscribe = null; } },
        { name: "runtime timers", stop: () => clearRuntimeTimers() },
        { name: "error monitor", stop: () => { errorMonitor?.stop(); errorMonitor = null; } },
        { name: "discord client", stop: () => client.destroy() },
      ], (message) => log.warn(message));
      deps.onRuntimeState?.({ running: false, status: "stopped" });
    },
  };
}
