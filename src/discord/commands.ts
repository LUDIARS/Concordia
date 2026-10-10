import {
  type Interaction,
  REST,
  Routes,
} from "discord.js";
import spawnCommand from "./commands/spawn.js";
import statCommand from "./commands/stat.js";
import prsCommand from "./commands/prs.js";
import rvPrsCommand from "./commands/rv-prs.js";
import endSessionCommand from "./commands/end-session.js";
import enterCommand from "./commands/enter.js";
import cleanCommand from "./commands/clean.js";
import mmtaskCommand from "./commands/mmtask.js";
import projectsCommand from "./commands/projects.js";
import domainReviewCommand from "./commands/domain-review.js";
import projectCodeCommand from "./commands/project-code.js";
import chNameCommand from "./commands/ch-name.js";
import compactionCommand from "./commands/compaction.js";
import contextCommand, { CONTEXT_COMPACT_PREFIX, handleContextCompactButton } from "./commands/context.js";
import { BUDGET_RESUME_PREFIX, handleBudgetResumeButton } from "./budget-resume.js";
import goalCommand from "./commands/goal.js";
import correctCommand from "./commands/correct.js";
import consultCommand from "./commands/consult.js";
import bugCommand from "./commands/bug.js";
import { handleBountyModalSubmit } from "./bounty-flow.js";
import { BOUNTY_CUSTOM_ID_PREFIX } from "./bounty-modal.js";
import budgetCommand from "./commands/budget.js";
import rewardCommand from "./commands/reward.js";
import { handleConsultApproval, handleConsultLifecycle, handleConsultModalSubmit } from "./consult-flow.js";
import { CONSULT_APPROVE_PREFIX, CONSULT_MODAL_PREFIX, parseConsultLifecycle } from "./consult-modal.js";
import {
  CONSULT_PUBLICATION_EDIT_PREFIX,
  CONSULT_PUBLICATION_PREFIX,
  handlePublicationButton,
  handlePublicationEditSubmit,
} from "./consult-publication.js";
import effortCommand from "./commands/effort.js";
import relictorCommand from "./commands/relictor.js";
import handoverCommand from "./commands/handover.js";
import confirmCommand from "./commands/confirm.js";
import ccSkillCommand from "./commands/cc-skill.js";
import { exRebootCommand, exRunCommand } from "./commands/excubitor.js";
import goalAndGoCommand from "./commands/goal-and-go.js";
import doctorCommand from "./commands/doctor.js";
import dailyGoalCommand from "./commands/daily-goal.js";
import { dispatchQuestionInteraction } from "./question.js";
import { dispatchPermissionInteraction, isPermissionInteraction, type PermissionActionStore } from "./permission.js";
import { handleControlInteraction, handleControlModalSubmit } from "./control.js";
import { interactionAgeMs } from "./interaction-diagnostics.js";
import { parseTestControlId } from "./test-forum-controls.js";
import { handlePanelInteraction, isPanelInteraction } from "./panel-interactions.js";
import { handleTeamAdminInteraction, isTeamAdminInteraction } from "./team-admin-panel.js";
import { handleTestForumControl } from "./test-forum-actions.js";
import type { DiscordCommandDeps, DiscordCommandSpec } from "./command-port.js";
import { isCommandWorkflowEnabled, workflowForCommand } from "./command-workflow.js";
import type { WorkflowKey } from "../workflow/keys.js";
import { handlePlanButton, handlePlanModal, PLAN_PREFIX } from "./plan-card.js";
import {
  dispatchForumSpawnIntakeInteraction,
  isForumSpawnIntakeInteraction,
} from "./forum-spawn-intake.js";
import { isSubsidiaryAllowedCommand, isSubsidiaryAllowedInteraction } from "./subsidiary-scope.js";
import { backlogCommands, handleBacklogCommand } from "./actio-backlog-command.js";
export type { DiscordCommandDeps, DiscordCommandSpec } from "./command-port.js";

/** ワークフロー有効化フラグを都度解決する resolver (省略時は全て有効扱い)。 */
export type WorkflowEnabledResolver = (key: WorkflowKey) => boolean;

export interface CommandRegistrationOptions {
  subsidiary?: boolean;
  /** 無効なワークフローのコマンドは guild へ登録しない。 */
  isWorkflowEnabled?: WorkflowEnabledResolver;
}

// User-facing slash commands.
const COMMANDS: DiscordCommandSpec[] = [
  spawnCommand,
  statCommand,
  prsCommand,
  rvPrsCommand,
  endSessionCommand,
  enterCommand,
  cleanCommand,
  mmtaskCommand,
  projectsCommand,
  projectCodeCommand,
  domainReviewCommand,
  chNameCommand,
  compactionCommand,
  contextCommand,
  goalCommand,
  correctCommand,
  consultCommand,
  bugCommand,
  budgetCommand,
  rewardCommand,
  effortCommand,
  relictorCommand,
  handoverCommand,
  confirmCommand,
  ccSkillCommand,
  exRunCommand,
  exRebootCommand,
  goalAndGoCommand,
  doctorCommand,
  dailyGoalCommand,
];

// 子会社 guild の許可範囲は subsidiary-scope.ts が正本 (登録と dispatch で同じ集合を使う)。
export { isSubsidiaryAllowedCommand, isSubsidiaryAllowedInteraction } from "./subsidiary-scope.js";

export function commandNamesForRegistration(opts: CommandRegistrationOptions = {}): string[] {
  const isWorkflowEnabled = opts.isWorkflowEnabled ?? (() => true);
  return COMMANDS
    .filter((c) => !opts.subsidiary || isSubsidiaryAllowedCommand(c.builder.name))
    .filter((c) => isCommandWorkflowEnabled(c.builder.name, isWorkflowEnabled))
    .map((c) => c.builder.name).concat(backlogCommands.map(c => c.name));
}

export async function registerGuildCommands(
  token: string,
  applicationId: string,
  guildId: string,
  opts: CommandRegistrationOptions = {},
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const allowed = new Set(commandNamesForRegistration(opts));
  const body = COMMANDS.filter((c) => allowed.has(c.builder.name)).map((c) => c.builder.toJSON());
  body.push(...backlogCommands);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body });
}

/** guild の slash commands を全解除する (子会社 guild にコマンドを出さないため)。 */
export async function clearGuildCommands(token: string, applicationId: string, guildId: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: [] });
}

export async function dispatchInteraction(interaction: Interaction, deps: DiscordCommandDeps): Promise<void> {
  // Session forum 起動の不足情報の回答は本社・子会社の両方で有効。
  // 子会社の許可判定より前に取り次ぐ (起動待ちのスレッド 1 本に閉じた操作)。
  if (isForumSpawnIntakeInteraction(interaction)) {
    if (!deps.forumSpawnIntakes || !deps.resumeForumSpawnIntake || !deps.replyToForumThread) {
      deps.log.warn("forum-spawn intake interaction unwired; ignoring");
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "この質問への回答を処理できません。Bot の設定を確認してください。",
          ephemeral: true,
        }).catch(() => { /* best-effort */ });
      }
      return;
    }
    await dispatchForumSpawnIntakeInteraction(interaction, {
      store: deps.forumSpawnIntakes,
      isLaunchUserAllowed: deps.isLaunchUserAllowed,
      resumeSpawn: deps.resumeForumSpawnIntake,
      reply: deps.replyToForumThread,
      log: deps.log,
    });
    return;
  }
  // 子会社 guild は許可範囲外のコマンド / 操作面を拒否する (subsidiary-scope.ts)。
  // 過去登録済みの guild からの残存コマンド実行もここで確実に弾く (二段防御)。
  if (deps.subsidiaryId && !isSubsidiaryAllowedInteraction(interaction)) {
    deps.log.warn(
      `discord interaction rejected (subsidiary) subsidiary=${deps.subsidiaryId} ` +
      `type=${interaction.type} name=${"commandName" in interaction ? String(interaction.commandName) : "-"}`,
    );
    if (interaction.isAutocomplete()) {
      await interaction.respond([]).catch(() => { /* best-effort */ });
    } else if (interaction.isRepliable()) {
      await interaction.reply({
        content: "このサーバではこの操作は利用できません。依頼は受付チャンネルか Session フォーラムへどうぞ。",
        ephemeral: true,
      }).catch(() => { /* best-effort */ });
    }
    return;
  }
  if (await handleBacklogCommand(interaction, deps.backlogAdmission)) return;
  const privileged = classifyPrivilegedInteraction(interaction);
  // 起動 (/spawn) は役職の承認を待たない (staff-roster.md §3)。 session_spawn はヒラ社員から
  // 通るので、 ここで弾かれるのは名簿の判定器が未配線 (fail-closed) か、 他の権限が要る操作だけ。
  if (privileged && !isPrivilegedActorAllowed(interaction, deps, privileged)) {
    const userId = "user" in interaction ? interaction.user?.id ?? "" : "";
    deps.log.warn(
      `discord ${privileged.capability} rejected unauthorized user=${userId || "-"} ` +
      `type=${interaction.type} name=${"commandName" in interaction ? String(interaction.commandName) : "-"}`,
    );
    if (interaction.isAutocomplete()) {
      // Autocomplete can contain private task/team labels, so reject it through
      // its own acknowledgement API instead of letting it reach the command.
      await interaction.respond([]).catch(() => { /* interaction may have expired; best-effort */ });
    } else if (interaction.isRepliable()) {
      await interaction.reply({
        content: privileged.denyMessage,
        ephemeral: true,
      }).catch(() => { /* interaction may already be acknowledged; best-effort */ });
    }
    return;
  }
  if (interaction.isChatInputCommand()) {
    const age = interactionAgeMs(interaction);
    deps.log.info(
      `discord command received name=${interaction.commandName} guild=${interaction.guildId ?? "-"} ` +
      `channel=${interaction.channelId ?? "-"} user=${interaction.user?.id ?? "-"} ` +
      `age_ms=${age ?? "-"}`,
    );
    const cmd = COMMANDS.find((c) => c.builder.name === interaction.commandName);
    if (!cmd) {
      deps.log.warn(`discord command ignored unknown name=${interaction.commandName}`);
      return;
    }
    const disabledWorkflow = disabledWorkflowForCommand(interaction.commandName, deps);
    if (disabledWorkflow) {
      deps.log.warn(
        `discord command rejected (workflow disabled) name=${interaction.commandName} workflow=${disabledWorkflow}`,
      );
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: `このコマンドが属するワークフロー (${disabledWorkflow}) は設定で無効です。設定から有効化してください。`,
          ephemeral: true,
        }).catch(() => { /* best-effort */ });
      }
      return;
    }
    await cmd.execute(interaction, deps);
    return;
  }
  if (interaction.isAutocomplete()) {
    const age = interactionAgeMs(interaction);
    deps.log.info(
      `discord autocomplete received name=${interaction.commandName} guild=${interaction.guildId ?? "-"} ` +
      `channel=${interaction.channelId ?? "-"} user=${interaction.user?.id ?? "-"} ` +
      `age_ms=${age ?? "-"}`,
    );
    if (disabledWorkflowForCommand(interaction.commandName, deps)) {
      await interaction.respond([]).catch(() => { /* best-effort */ });
      return;
    }
    const cmd = COMMANDS.find((c) => c.builder.name === interaction.commandName);
    if (cmd?.autocomplete) {
      await cmd.autocomplete(interaction, deps);
    } else {
      deps.log.warn(`discord autocomplete ignored name=${interaction.commandName}`);
    }
    return;
  }
  if (isPermissionInteraction(interaction)) {
    await dispatchPermissionInteraction(interaction, deps);
    return;
  }
  if (
    (interaction.isButton() || interaction.isStringSelectMenu()) &&
    interaction.customId.startsWith("ctrl:")
  ) {
    await handleControlInteraction(interaction, {
      concordiaUrl: deps.concordiaUrl,
      sessionsRepo: deps.sessionsRepo,
      sessionChannelsRepo: deps.sessionChannelsRepo,
      log: deps.log,
    });
    return;
  }
  // PR 提出 / マージ操作パネル (embed + select + button)。
  if (isPanelInteraction(interaction)) {
    await handlePanelInteraction(interaction, {
      sessionsRepo: deps.sessionsRepo,
      prOperations: deps.prOperations,
      isMergeUserAllowed: deps.isMergeUserAllowed,
      log: deps.log,
    });
    return;
  }
  // プライベート相談のモーダル送信 / 承認ボタン (tech-consultation.md §4)。 子会社 Bot は相談部署のある会社で配線される (§6)。
  if ((interaction.isModalSubmit() && interaction.customId.startsWith(CONSULT_MODAL_PREFIX))
    || (interaction.isButton() && interaction.customId.startsWith(CONSULT_APPROVE_PREFIX))
    || (interaction.isButton() && parseConsultLifecycle(interaction.customId) !== null)) {
    if (!deps.consult) {
      await interaction.reply({ content: "プライベート相談はこの Bot で使えません。", ephemeral: true }).catch(() => { /* best-effort */ });
      return;
    }
    if (interaction.isModalSubmit()) await handleConsultModalSubmit(interaction, deps.consult);
    else if (parseConsultLifecycle(interaction.customId)) await handleConsultLifecycle(interaction, deps.consult);
    else await handleConsultApproval(interaction, deps.consult);
    return;
  }
  // バグ報告のモーダル送信 (bug-bounty.md §3)。 本社・子会社の両方で受ける。
  if (interaction.isModalSubmit() && interaction.customId.startsWith(BOUNTY_CUSTOM_ID_PREFIX)) {
    if (!deps.bounty) {
      await interaction.reply({ content: "バグ報告はこの Bot で使えません。", ephemeral: true }).catch(() => { /* best-effort */ });
      return;
    }
    await handleBountyModalSubmit(interaction, deps.bounty);
    return;
  }
  // 公開候補カードのボタン / 直して公開のモーダル (tech-consultation.md §5)。
  if ((interaction.isButton() && interaction.customId.startsWith(CONSULT_PUBLICATION_PREFIX))
    || (interaction.isModalSubmit() && interaction.customId.startsWith(CONSULT_PUBLICATION_EDIT_PREFIX))) {
    const publication = deps.consult?.publication;
    if (!publication) {
      await interaction.reply({ content: "公開候補の判断はこの Bot で使えません。", ephemeral: true }).catch(() => { /* best-effort */ });
      return;
    }
    if (interaction.isButton()) await handlePublicationButton(interaction, publication);
    else await handlePublicationEditSubmit(interaction, publication);
    return;
  }
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    // チーム管理チャンネルの一時停止 / 再開ボタン。
    if (interaction.isButton() && isTeamAdminInteraction(interaction)) {
      if (!deps.teams) {
        deps.log.warn("team-admin control unavailable: teams repo missing");
        await interaction.reply({ content: "チーム管理の準備ができていません。Bot の設定を確認してください。", ephemeral: true });
        return;
      }
      await handleTeamAdminInteraction(interaction, {
        teams: deps.teams,
        isSuspendUserAllowed: deps.isTeamSuspendUserAllowed,
        log: deps.log,
      });
      return;
    }
    if(interaction.isButton()&&interaction.customId.startsWith(PLAN_PREFIX)){await handlePlanButton(interaction,deps.concordiaUrl);return;}
    if (interaction.isButton() && interaction.customId.startsWith(CONTEXT_COMPACT_PREFIX)) {
      await handleContextCompactButton(interaction, { sessionsRepo: deps.sessionsRepo, concordiaUrl: deps.concordiaUrl });
      return;
    }
    // 予算切れで中断したセッションの「再開」(usage-budgets.md §5.3)。 押せる人の判定は Concordia が持つ。
    if (interaction.isButton() && interaction.customId.startsWith(BUDGET_RESUME_PREFIX)) {
      await handleBudgetResumeButton(interaction, { concordiaUrl: deps.concordiaUrl });
      return;
    }
    const control = parseTestControlId(interaction.customId);
    if (control) {
      if (!deps.testSurfacesRepo || !deps.revisor) {
        deps.log.warn(`test-forum control unavailable surface=${control.surfaceId}: dependencies missing`);
        await interaction.reply({ content: "テスト操作の準備ができていません。Bot の設定を確認してください。", ephemeral: true });
        return;
      }
      await handleTestForumControl(interaction, control, {
        concordiaUrl: deps.concordiaUrl,
        workspaceRoots: deps.resolveWorkspaceRoots?.(),
        surfaces: deps.testSurfacesRepo,
        revisor: deps.revisor,
        isLaunchUserAllowed: deps.isLaunchUserAllowed,
        // 実行設定 (provider / effort) は起動とは別の運用権限 (session_control)。
        isSessionControlUserAllowed: deps.isSessionControlUserAllowed,
        // マージは `merge_pr` capability で判定する。
        isMergeUserAllowed: deps.isMergeUserAllowed,
        log: deps.log,
      });
      return;
    }
    await dispatchQuestionInteraction(interaction, deps);
    return;
  }
  // Modal submits: AskUserQuestion の「その他 (自由入力)」(customId `qothm:`)。
  // 他の modal surface は無いので、それ以外は無視。
  if (interaction.isModalSubmit() && interaction.customId.startsWith("qothm:")) {
    await dispatchQuestionInteraction(interaction, deps);
    return;
  }
  if(interaction.isModalSubmit()&&interaction.customId.startsWith(`${PLAN_PREFIX}revise-modal:`)){await handlePlanModal(interaction,deps.concordiaUrl);return;}
  if (interaction.isModalSubmit() && interaction.customId.startsWith("ctrl:")) {
    await handleControlModalSubmit(interaction, { concordiaUrl: deps.concordiaUrl, log: deps.log });
  }
}

/**
 * 権限が必要な操作の分類。 社員名簿の役職で判定する (spec/feature/staff-roster.md §3)。
 * ここに載らない操作 (会話 / 状況確認など) はヒラ社員でも通す。
 */
interface PrivilegedInteraction {
  capability: "session_spawn" | "session_control" | "session_end" | "session_succession" | "kill_switch";
  /** 拒否時に本人へ返す ephemeral メッセージ。 */
  denyMessage: string;
  check: (deps: DiscordCommandDeps) => ((userId: string) => boolean) | undefined;
}

const PRIVILEGED_SESSION_SPAWN: PrivilegedInteraction = {
  capability: "session_spawn",
  denyMessage: "このユーザーにはセッション起動権限がありません。",
  check: (deps) => deps.isLaunchUserAllowed,
};
const PRIVILEGED_SESSION_END: PrivilegedInteraction = {
  capability: "session_end",
  denyMessage: "このユーザーにはセッション終了権限がありません (管理職以上が必要)。",
  check: (deps) => deps.isSessionEndUserAllowed,
};
const PRIVILEGED_SESSION_SUCCESSION: PrivilegedInteraction = {
  capability: "session_succession",
  denyMessage: "このユーザーにはセッション移行権限がありません (起動・終了の両権限が必要)。",
  check: (deps) => {
    const canLaunch = deps.isLaunchUserAllowed;
    const canEnd = deps.isSessionEndUserAllowed;
    if (!canLaunch || !canEnd) return undefined;
    return (userId) => canLaunch(userId) && canEnd(userId);
  },
};
const PRIVILEGED_KILL_SWITCH: PrivilegedInteraction = {
  capability: "kill_switch",
  denyMessage: "このユーザーにはサービス操作権限がありません (執行役員のみ)。",
  check: (deps) => deps.isKillSwitchUserAllowed,
};
const PRIVILEGED_EFFORT_CHANGE: PrivilegedInteraction = {
  capability: "session_control",
  denyMessage: "このユーザーには effort の変更権限がありません (管理職以上が必要)。",
  check: (deps) => deps.isSessionControlUserAllowed,
};
const PRIVILEGED_PLAN_DECISION: PrivilegedInteraction = {
  capability: "session_control",
  denyMessage: "このユーザーにはプラン承認・受け入れ権限がありません (管理職以上が必要)。",
  check: (deps) => deps.isSessionControlUserAllowed,
};
const PRIVILEGED_PROJECT_BINDING: PrivilegedInteraction = {
  capability: "session_control",
  denyMessage: "このユーザーにはプロジェクトコードの登録権限がありません (管理職以上が必要)。",
  check: (deps) => deps.isSessionControlUserAllowed,
};

/** キルスイッチ相当 = Excubitor 経由でサービスを起動 / 再起動するコマンド。 */
const KILL_SWITCH_COMMANDS = new Set(["ex-run", "ex-reboot"]);
/** 新セッションを起動して旧セッションを終了するため、両 capability が必要。 */
const SESSION_SUCCESSION_COMMANDS = new Set(["co-relictor", "co-handover"]);

/**
 * そのコマンドが「無効なワークフロー」に属していれば、 そのワークフローキーを返す。
 * 判定器が未注入なら従来どおり全て有効として扱う (既存構成の挙動を変えない)。
 */
function disabledWorkflowForCommand(name: string, deps: DiscordCommandDeps): WorkflowKey | null {
  const key = workflowForCommand(name);
  if (key === null) return null;
  if (!deps.isWorkflowEnabled) return null;
  return deps.isWorkflowEnabled(key) ? null : key;
}

function classifyPrivilegedInteraction(interaction: Interaction): PrivilegedInteraction | null {
  if (interaction.isAutocomplete()) {
    // `/spawn` choices include Memoria task titles. Apply the same fail-closed
    // authorization as execution so autocomplete cannot become a read bypass.
    return interaction.commandName === "spawn" ? PRIVILEGED_SESSION_SPAWN : null;
  }
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "spawn") return PRIVILEGED_SESSION_SPAWN;
    if (interaction.commandName === "end-session") return PRIVILEGED_SESSION_END;
    // effort は費用に直結するので、 起動とは別に管理職以上の運用権限を要求する。
    if (interaction.commandName === "co-effort") return PRIVILEGED_EFFORT_CHANGE;
    // `/project-code add` は repository binding の正本を書き換え、以後の spawn 先を
    // 決めてしまう。読み取り専用の list は `/projects` と同じ一般参照面のままにする。
    if (
      interaction.commandName === "project-code"
      && interaction.options.getSubcommand(false) === "add"
    ) return PRIVILEGED_PROJECT_BINDING;
    if (SESSION_SUCCESSION_COMMANDS.has(interaction.commandName)) return PRIVILEGED_SESSION_SUCCESSION;
    if (KILL_SWITCH_COMMANDS.has(interaction.commandName)) return PRIVILEGED_KILL_SWITCH;
    return null;
  }
  if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
    const id = interaction.customId;
    if (id.startsWith(PLAN_PREFIX)) return PRIVILEGED_PLAN_DECISION;
    if (id.startsWith("ctrl:spawn:") || id.startsWith("ctrl:spawn-modal:")) {
      return PRIVILEGED_SESSION_SPAWN;
    }
    // コントロールパネルの End Session (ボタン → 選択 → confirm の全段)。
    if (id.startsWith("ctrl:end-session")) {
      return PRIVILEGED_SESSION_END;
    }
    return null;
  }
  return null;
}

/** 判定関数が未注入なら deny (fail-closed)。 */
function isPrivilegedActorAllowed(
  interaction: Interaction,
  deps: DiscordCommandDeps,
  privileged: PrivilegedInteraction,
): boolean {
  const userId = "user" in interaction ? interaction.user?.id?.trim() ?? "" : "";
  if (userId.length === 0) return false;
  return privileged.check(deps)?.(userId) === true;
}
