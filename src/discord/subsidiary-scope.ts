/**
 * 子会社 (出張先) guild で使える Discord コマンドと interaction の範囲。
 *
 * 子会社 Bot は本社と同じ application を共有するため、本社に登録した全コマンド /
 * 全操作面が出張先でも押せてしまう。ここで「出張先に出してよい面」だけを列挙し、
 * 登録 (registerGuildCommands) と dispatch の両方で同じ集合を使う (二段防御)。
 *
 * 方針 (2026-09-01 neco 指示):
 *  - `/spawn` は使える。ただし可否は社員名簿の役職を **user id で引いて** 判定する
 *    (`session_spawn` = 管理職以上)。起動先は関係プロジェクトに閉じる。
 *  - セッションを動かす面 (質問への回答 / 許可要求 / context 圧縮 / プラン判断 /
 *    Session forum の起動承認・不足情報の回答) は使える。
 *  - 会社運営の面 (コントロールパネル / PR キュー / Test forum の操作 / チーム管理 /
 *    執行役員への spawn 一回許可) は出さない。本社の事情が出張先へ漏れるため。
 *
 * @implements spec/feature/subsidiary-delegation.md §3.1
 */

import type { Interaction } from "discord.js";
import { CONTEXT_COMPACT_PREFIX } from "./commands/context.js";
import { PLAN_PREFIX } from "./plan-card.js";
import { isQuestionInteraction } from "./question.js";
import { isPermissionInteraction } from "./permission.js";
import { isForumSpawnApprovalInteraction } from "./forum-spawn-approval.js";
import { isForumSpawnIntakeInteraction } from "./forum-spawn-intake.js";

/**
 * 子会社 guild へ登録する slash command。
 * `spawn` の可否は役職判定 (commands.ts の PRIVILEGED_SESSION_SPAWN) が決める。
 */
const SUBSIDIARY_ALLOWED_COMMAND_NAMES = new Set(["ch_name", "spawn"]);

export function isSubsidiaryAllowedCommand(name: string): boolean {
  return SUBSIDIARY_ALLOWED_COMMAND_NAMES.has(name);
}

/**
 * 子会社 guild で処理してよい interaction か。
 * コマンド / autocomplete は許可コマンド名で、それ以外はセッション面かどうかで判定する。
 */
export function isSubsidiaryAllowedInteraction(interaction: Interaction): boolean {
  // 種別は discord.js の型述語ではなく形で見る — interaction の部分実装でも落ちないように。
  if ("commandName" in interaction) {
    return isSubsidiaryAllowedCommand(String(interaction.commandName));
  }
  return isSubsidiarySessionSurface(interaction);
}

/**
 * セッションを動かす操作面か。 コントロールパネル (`ctrl:`) / PR パネル / Test forum /
 * チーム管理 / 執行役員承認は **含めない** — いずれも本社運営の面。
 */
export function isSubsidiarySessionSurface(interaction: Interaction): boolean {
  if (isQuestionInteraction(interaction)) return true;
  if (isPermissionInteraction(interaction)) return true;
  if (isForumSpawnApprovalInteraction(interaction)) return true;
  if (isForumSpawnIntakeInteraction(interaction)) return true;
  if (!("customId" in interaction) || typeof interaction.customId !== "string") return false;
  return interaction.customId.startsWith(CONTEXT_COMPACT_PREFIX)
    || interaction.customId.startsWith(PLAN_PREFIX);
}
