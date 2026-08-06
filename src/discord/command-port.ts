import type { AutocompleteInteraction, ChatInputCommandInteraction, Guild } from "discord.js";
import type { DiscordPendingQuestionsRepo, DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { AnswerQuestionFn } from "../platform/answer-question.js";
import type { DiscordConfigSnapshot } from "./config.js";
import type { PermissionActionStore } from "./permission-port.js";
import type { DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type { RevisorLocalPrMerger, RevisorLocalPrReader } from "../pr/revisor-client.js";
import type { ModelReviewPort, RuntimeModelReviewApplyResult } from "../model-review/contracts.js";

export interface DiscordCommandDeps {
  concordiaUrl: string;
  sessionsRepo: SessionsRepo;
  sessionChannelsRepo: DiscordSessionChannelsRepo;
  pendingQuestionsRepo: DiscordPendingQuestionsRepo;
  testSurfacesRepo?: DiscordTestSurfacesRepo;
  revisor?: RevisorLocalPrReader & RevisorLocalPrMerger;
  modelReview?: ModelReviewPort;
  applyRuntimeModelReview?: (input: {
    sessionId: string;
    model: string;
    effort: string;
  }) => Promise<RuntimeModelReviewApplyResult>;
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
}

export interface DiscordCommandSpec {
  builder: { name: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction, deps: DiscordCommandDeps) => Promise<void>;
  autocomplete?: (interaction: AutocompleteInteraction, deps: DiscordCommandDeps) => Promise<void>;
}
