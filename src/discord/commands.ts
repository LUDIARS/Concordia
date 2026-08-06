import {
  type Interaction,
  REST,
  Routes,
} from "discord.js";
import spawnCommand from "./commands/spawn.js";
import statCommand from "./commands/stat.js";
import prsCommand from "./commands/prs.js";
import endSessionCommand from "./commands/end-session.js";
import enterCommand from "./commands/enter.js";
import cleanCommand from "./commands/clean.js";
import mmtaskCommand from "./commands/mmtask.js";
import projectsCommand from "./commands/projects.js";
import chNameCommand from "./commands/ch-name.js";
import compactionCommand from "./commands/compaction.js";
import goalCommand from "./commands/goal.js";
import relictorCommand from "./commands/relictor.js";
import confirmCommand from "./commands/confirm.js";
import ccSkillCommand from "./commands/cc-skill.js";
import { exRebootCommand, exRunCommand } from "./commands/excubitor.js";
import { dispatchQuestionInteraction } from "./question.js";
import { dispatchPermissionInteraction, isPermissionInteraction, type PermissionActionStore } from "./permission.js";
import { handleControlInteraction, handleControlModalSubmit } from "./control.js";
import { interactionAgeMs } from "./interaction-diagnostics.js";
import { parseTestControlId } from "./test-forum-controls.js";
import { handleTestForumControl } from "./test-forum-actions.js";
import type { DiscordCommandDeps, DiscordCommandSpec } from "./command-port.js";
export type { DiscordCommandDeps, DiscordCommandSpec } from "./command-port.js";

// User-facing slash commands.
const COMMANDS: DiscordCommandSpec[] = [
  spawnCommand,
  statCommand,
  prsCommand,
  endSessionCommand,
  enterCommand,
  cleanCommand,
  mmtaskCommand,
  projectsCommand,
  chNameCommand,
  compactionCommand,
  goalCommand,
  relictorCommand,
  confirmCommand,
  ccSkillCommand,
  exRunCommand,
  exRebootCommand,
];

const SUBSIDIARY_ALLOWED_COMMAND_NAMES = new Set(["ch_name"]);

export function isSubsidiaryAllowedCommand(name: string): boolean {
  return SUBSIDIARY_ALLOWED_COMMAND_NAMES.has(name);
}

export function isSubsidiaryAllowedInteraction(interaction: Interaction): boolean {
  return "commandName" in interaction && isSubsidiaryAllowedCommand(String(interaction.commandName));
}

export function commandNamesForRegistration(opts: { subsidiary?: boolean } = {}): string[] {
  return COMMANDS
    .filter((c) => !opts.subsidiary || isSubsidiaryAllowedCommand(c.builder.name))
    .map((c) => c.builder.name);
}

export async function registerGuildCommands(
  token: string,
  applicationId: string,
  guildId: string,
  opts: { subsidiary?: boolean } = {},
): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const allowed = new Set(commandNamesForRegistration(opts));
  const body = COMMANDS.filter((c) => allowed.has(c.builder.name)).map((c) => c.builder.toJSON());
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body });
}

/** guild の slash commands を全解除する (子会社 guild にコマンドを出さないため)。 */
export async function clearGuildCommands(token: string, applicationId: string, guildId: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: [] });
}

export async function dispatchInteraction(interaction: Interaction, deps: DiscordCommandDeps): Promise<void> {
  // 子会社 guild では許可リスト外の Discord コマンドを拒否する。作業依頼 / spawn 系は
  // 受付チャンネルのメッセージ → ガードゲート経由のみ。過去登録済みの guild からの
  // 残存コマンド実行もここで確実に弾く (二段防御)。
  if (deps.subsidiaryId && !isSubsidiaryAllowedInteraction(interaction)) {
    deps.log.warn(
      `discord interaction rejected (subsidiary) subsidiary=${deps.subsidiaryId} ` +
      `type=${interaction.type} name=${"commandName" in interaction ? String(interaction.commandName) : "-"}`,
    );
    if (interaction.isAutocomplete()) {
      await interaction.respond([]).catch(() => { /* best-effort */ });
    } else if (interaction.isRepliable()) {
      await interaction.reply({
        content: "このサーバでは Discord コマンドは利用できません。依頼は受付チャンネルへメッセージでどうぞ。",
        ephemeral: true,
      }).catch(() => { /* best-effort */ });
    }
    return;
  }
  const privileged = classifyPrivilegedInteraction(interaction);
  if (privileged && !isPrivilegedActorAllowed(interaction, deps, privileged)) {
    const userId = "user" in interaction ? interaction.user?.id ?? "" : "";
    deps.log.warn(
      `discord ${privileged.capability} rejected unauthorized user=${userId || "-"} ` +
      `type=${interaction.type} name=${"commandName" in interaction ? String(interaction.commandName) : "-"}`,
    );
    if (interaction.isRepliable()) {
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
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
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
        // マージは `merge_pr` capability で判定する。 現状 spawn と同じ最低役職だが、
        // 表 (CAPABILITY_MIN_ROLE) が動いたときに片方だけずれるのを避ける。
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
  if (interaction.isModalSubmit() && interaction.customId.startsWith("ctrl:")) {
    await handleControlModalSubmit(interaction, { concordiaUrl: deps.concordiaUrl, log: deps.log });
  }
}

/**
 * 権限が必要な操作の分類。 社員名簿の役職で判定する (spec/feature/staff-roster.md §3)。
 * ここに載らない操作 (会話 / 状況確認など) はヒラ社員でも通す。
 */
interface PrivilegedInteraction {
  capability: "session_spawn" | "session_end" | "kill_switch";
  /** 拒否時に本人へ返す ephemeral メッセージ。 */
  denyMessage: string;
  check: (deps: DiscordCommandDeps) => ((userId: string) => boolean) | undefined;
}

const PRIVILEGED_SESSION_SPAWN: PrivilegedInteraction = {
  capability: "session_spawn",
  denyMessage: "このユーザーにはセッション起動権限がありません (管理職以上が必要)。",
  check: (deps) => deps.isLaunchUserAllowed,
};
const PRIVILEGED_SESSION_END: PrivilegedInteraction = {
  capability: "session_end",
  denyMessage: "このユーザーにはセッション終了権限がありません (管理職以上が必要)。",
  check: (deps) => deps.isSessionEndUserAllowed,
};
const PRIVILEGED_KILL_SWITCH: PrivilegedInteraction = {
  capability: "kill_switch",
  denyMessage: "このユーザーにはサービス操作権限がありません (執行役員のみ)。",
  check: (deps) => deps.isKillSwitchUserAllowed,
};

/** キルスイッチ相当 = Excubitor 経由でサービスを起動 / 再起動するコマンド。 */
const KILL_SWITCH_COMMANDS = new Set(["ex-run", "ex-reboot"]);

function classifyPrivilegedInteraction(interaction: Interaction): PrivilegedInteraction | null {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "spawn") return PRIVILEGED_SESSION_SPAWN;
    if (interaction.commandName === "end-session") return PRIVILEGED_SESSION_END;
    if (KILL_SWITCH_COMMANDS.has(interaction.commandName)) return PRIVILEGED_KILL_SWITCH;
    return null;
  }
  if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu()) {
    const id = interaction.customId;
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
