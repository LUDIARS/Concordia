/**
 * 子会社 (出張先) guild で使える Discord コマンドと interaction の範囲。
 *
 * 子会社 Bot は本社と同じ application を共有するため、本社に登録した全コマンド /
 * 全操作面が出張先でも押せてしまう。ここで「出張先に出してよい面」だけを列挙し、
 * 登録 (registerGuildCommands) と dispatch の両方で同じ集合を使う (二段防御)。
 *
 * 方針 (2026-09-01 neco 指示、2026-09-02 改訂):
 *  - `/spawn` は**出さない** (2026-09-02 neco 指示: 子会社では Session forum の
 *    spawn-by-post が窓口で、コマンドは意味が薄い)。起動は Session forum スレッド経由。
 *  - セッションを動かす面 (質問への回答 / 許可要求 / context 圧縮 / プラン判断 /
 *    Session forum の不足情報の回答) は使える。 起動の役職承認は廃止済み (staff-roster.md §3)。
 *  - 会社運営の面 (コントロールパネル / PR キュー / Test forum の操作 / チーム管理) は
 *    出さない。本社の事情が出張先へ漏れるため。
 *  - `/consult` (プライベート相談) は出す (2026-10-01 neco 指示: 子会社の相談窓口)。 受けるのは
 *    その子会社のプロジェクトを持たない相談部署だけ (tech-consultation.md §6)。 公開候補 (Tabula へ
 *    出す wrap とそのカード) は本社の知見共有の面なので出さない。
 *
 * @implements spec/feature/subsidiary-delegation.md §3.1
 */

import type { Interaction } from "discord.js";
import { CONTEXT_COMPACT_PREFIX } from "./commands/context.js";
import { PLAN_PREFIX } from "./plan-card.js";
import { isQuestionInteraction } from "./question.js";
import { isPermissionInteraction } from "./permission.js";
import { isForumSpawnIntakeInteraction } from "./forum-spawn-intake.js";
import { CONSULT_APPROVE_PREFIX, CONSULT_MODAL_PREFIX } from "./consult-modal.js";
import { BUDGET_RESUME_PREFIX } from "./budget-resume.js";

/**
 * 子会社 guild へ登録する slash command。
 * `spawn` は出さない (2026-09-02 neco 指示) — 子会社の起動窓口は Session forum に一本化。
 */
const SUBSIDIARY_ALLOWED_COMMAND_NAMES = new Set(["ch_name", "backlog", "バックログに追加", "consult"]);

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
 * チーム管理は **含めない** — いずれも本社運営の面。
 */
export function isSubsidiarySessionSurface(interaction: Interaction): boolean {
  if (isQuestionInteraction(interaction)) return true;
  if (isPermissionInteraction(interaction)) return true;
  if (isForumSpawnIntakeInteraction(interaction)) return true;
  if (!("customId" in interaction) || typeof interaction.customId !== "string") return false;
  return interaction.customId.startsWith(CONTEXT_COMPACT_PREFIX)
    || interaction.customId.startsWith(PLAN_PREFIX)
    // プライベート相談の受付モーダルと承認ボタン。 公開候補 (consult:pub*) は含めない。
    || interaction.customId.startsWith(CONSULT_MODAL_PREFIX)
    || interaction.customId.startsWith(CONSULT_APPROVE_PREFIX)
    // 予算切れで中断したセッションの「再開」 (usage-budgets.md §5.3)。 子会社のセッションも再開できる。
    || interaction.customId.startsWith(BUDGET_RESUME_PREFIX);
}
