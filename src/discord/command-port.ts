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
import type { ConsultCommandDeps } from "./commands/consult.js";

export interface DiscordCommandDeps {
  backlogAdmission?: (guildId: string, channelId: string) => Promise<boolean>;
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
  /** Session forum spawn の不足情報 (関係プロジェクト / タスク内容) の回答待ち。 */
  forumSpawnIntakes?: import("./forum-spawn-intake.js").ForumSpawnIntakeStore;
  /** 回答で補完した内容から spawn を再開する (bot.ts が thread 再取得を配線)。 */
  resumeForumSpawnIntake?: (
    threadId: string,
    content: import("./forum-spawn.js").SuppliedForumSpawnContent,
  ) => Promise<void>;
  /** Session forum スレッドへの通常返信 (webhook 経由)。 */
  replyToForumThread?: (threadId: string, content: string) => Promise<void>;
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
  /** セッションの spawn (ヒラ社員から可。 起動の承認は廃止、 staff-roster.md §3)。 */
  isLaunchUserAllowed?: (userId: string) => boolean;
  /**
   * 起動以外のセッション運用操作 (`session_control`, 管理職以上): effort の変更・プラン判断・
   * 訂正の登録・Test forum の実行設定・`/project-code add`。 未注入は deny (fail-closed)。
   */
  isSessionControlUserAllowed?: (userId: string) => boolean;
  /** プライベート相談 (spec/feature/tech-consultation.md §4)。 本社 Bot だけに配線する。 */
  consult?: ConsultCommandDeps;
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
