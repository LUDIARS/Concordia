import type { AutocompleteInteraction, ChatInputCommandInteraction, Guild } from "discord.js";
import type { DiscordPendingQuestionsRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TeamsRepo } from "../db/teams-repo.js";
import type { MemoriaClient } from "../memoria/client.js";
import type { AnswerQuestionFn } from "../platform/answer-question.js";
import type { DiscordConfigSnapshot } from "./config.js";
import type { PermissionActionStore } from "./permission-port.js";
import type { DependencyReadinessReport } from "../operations/dependency-readiness.js";
import type { DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type { RevisorLocalPrMerger, RevisorLocalPrReader } from "../pr/revisor-client.js";
import type { WorkflowKey } from "../workflow/keys.js";
import type { SessionPrPort } from "../pr/session-pr-operations.js";

export interface SpawnApprovalAction {
  requesterUserId: string;
  guildId: string;
  channelId: string;
  commandSignature: string;
  status: "pending" | "approved";
  createdAt: number;
}

export type SpawnApprovalStore = Map<string, SpawnApprovalAction>;

export interface DiscordCommandDeps {
  concordiaUrl: string;
  sessionsRepo: SessionsRepo;
  /** チーム候補の補完と、チャンネル起点のチーム帰属に使う (spec/feature/teams.md §2)。 */
  teams?: TeamsRepo;
  /** `/spawn` の task 候補。 未注入なら task 補完は空を返す (spawn 自体は続行できる)。 */
  memoria?: Pick<MemoriaClient, "listOpenTasks">;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  pendingQuestionsRepo: DiscordPendingQuestionsRepo;
  testSurfacesRepo?: DiscordTestSurfacesRepo;
  revisor?: RevisorLocalPrReader & RevisorLocalPrMerger;
  answerQuestion?: AnswerQuestionFn;
  guild: Guild;
  layout: DiscordConfigSnapshot;
  log: { info: (message: string) => void; warn: (message: string) => void };
  logsDir?: string;
  permissionActions?: PermissionActionStore;
  /** `/spawn` 権限不足時の執行役員向け一回許可。Bot process 内で期限付き保持する。 */
  spawnApprovals?: SpawnApprovalStore;
  /** Forum spawn の承認ボタン (権限なし投稿者のスレッドを管理職以上が許可する)。 */
  forumSpawnApprovals?: import("./forum-spawn-approval.js").ForumSpawnApprovalStore;
  /** 承認カード投稿者として許可する、この logical Bot 自身。 */
  forumSpawnApprovalCardAuthorId?: string;
  /** 承認された forum スレッドで spawn を続行する (bot.ts が thread 再取得を配線)。 */
  /** 再起動で pending が消えた承認カード押下から、内容指紋が一致する承認対象を復元する。 */
  recoverForumSpawnApproval?: (
    threadId: string,
    snapshot: import("./forum-spawn-approval.js").ForumSpawnApprovalCardSnapshot | null,
  ) => Promise<
    { requesterUserId: string; approvedContent: import("./forum-spawn.js").ApprovedForumSpawnContent } | null
  >;
  executeApprovedForumSpawn?: (
    threadId: string,
    approvedContent: import("./forum-spawn.js").ApprovedForumSpawnContent,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Session forum spawn の不足情報 (関係プロジェクト / タスク内容) の回答待ち。 */
  forumSpawnIntakes?: import("./forum-spawn-intake.js").ForumSpawnIntakeStore;
  /** 回答で補完した内容から spawn を再開する (bot.ts が thread 再取得を配線)。 */
  resumeForumSpawnIntake?: (
    threadId: string,
    content: import("./forum-spawn.js").SuppliedForumSpawnContent,
  ) => Promise<void>;
  /** Session forum スレッドへの通常返信 (webhook 経由)。 */
  replyToForumThread?: (threadId: string, content: string) => Promise<void>;
  /** Discord 社員名簿から執行役員だけを live 解決する。 */
  listExecutiveDiscordUserIds?: () => string[];
  /** Cc が利用する兄弟サービスの catalog / liveness /資格情報を一括診断する。 */
  checkDependencies?: () => Promise<DependencyReadinessReport>;
  resolveWorkspaceRoots?: () => string[];
  subsidiaryId?: string | null;
  /**
   * 子会社の関係プロジェクト (spec §3.4)。 `subsidiaryId` があるときは必須で、
   * `/spawn` の対象をこの集合に閉じる。 本社 Bot は指定しない (= 制限なし)。
   */
  resolveSubsidiaryProjects?: () => readonly string[];
  /**
   * 社員名簿 (staff_members) の役職に基づく権限判定。 いずれも未注入なら deny 側に倒す
   * (fail-closed) — 名簿が配線されていない環境で権限操作を通すべきではない。
   */
  /** セッションの spawn (管理職以上)。 */
  isLaunchUserAllowed?: (userId: string) => boolean;
  /** セッションの end-session (管理職以上)。 */
  isSessionEndUserAllowed?: (userId: string) => boolean;
  /** PR のマージ (`merge_pr`, 管理職以上)。 spawn 権限とは別の capability。 */
  isMergeUserAllowed?: (userId: string) => boolean;
  /** チームの一時停止 / 再開 (`session_end` capability, 管理職以上)。 */
  isTeamSuspendUserAllowed?: (userId: string) => boolean;
  /** キルスイッチ = Excubitor 経由のサービス起動 / 再起動 (執行役員のみ)。 */
  isKillSwitchUserAllowed?: (userId: string) => boolean;
  /**
   * ワークフロー有効化フラグの都度解決。 コマンド登録は無効時に外すが、 guild 側に
   * 残った登録から実行されうるので dispatch でも同じ判定を通す (二段防御)。
  */
  isWorkflowEnabled?: (key: WorkflowKey) => boolean;
  /**
   * PR 提出 / マージ操作パネルの実体。 リアクションワークフロー (📮 / 🔀) と同じ口を
   * 使う。 未注入なら操作パネルは「使えない」と明示して返す (無言で何も起きない、にしない)。
   */
  prOperations?: SessionPrPort;
}

export interface DiscordCommandSpec {
  builder: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction, deps: DiscordCommandDeps) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction, deps: DiscordCommandDeps) => Promise<void>;
}
