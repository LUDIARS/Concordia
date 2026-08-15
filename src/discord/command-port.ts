import type { AutocompleteInteraction, ChatInputCommandInteraction, Guild } from "discord.js";
import type { DiscordPendingQuestionsRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { TeamsRepo } from "../db/teams-repo.js";
import type { MemoriaClient } from "../memoria/client.js";
import type { AnswerQuestionFn } from "../platform/answer-question.js";
import type { DiscordConfigSnapshot } from "./config.js";
import type { PermissionActionStore } from "./permission-port.js";
import type { DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type { RevisorLocalPrMerger, RevisorLocalPrReader } from "../pr/revisor-client.js";
import type { WorkflowKey } from "../workflow/keys.js";
import type { SessionPrPort } from "../pr/session-pr-operations.js";
import type {
  ReactionWorkflowInput,
  WorkflowAction,
  WorkflowResultRelay,
} from "../platform/reaction-workflow.js";

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
  resolveWorkspaceRoots?: () => string[];
  subsidiaryId?: string | null;
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
  /**
   * RWF アクション選択パネルからワークフローを起こす口。 絵文字リアクションと同じ
   * runner を通すので、 権限判定・再発火抑制も共通になる。
   */
  reactionWorkflow?: {
    handle(
      input: ReactionWorkflowInput,
      onAccept?: (action: WorkflowAction) => void,
      onResult?: (action: WorkflowAction, result: WorkflowResultRelay) => void,
     ): Promise<void>;
   };
}

export interface DiscordCommandSpec {
  builder: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction, deps: DiscordCommandDeps) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction, deps: DiscordCommandDeps) => Promise<void>;
}
