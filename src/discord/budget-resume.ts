/**
 * 予算切れで中断したセッションの「再開」ボタン (spec/feature/usage-budgets.md §5.3)。
 *
 * - 予算が戻ったら、 中断したセッションのスレッドへボタンを出す (そのセッションを持つ Bot だけ)。
 * - 押されたら Concordia の再開 API へ押した人を渡す。 押せる人 (起動者・助けに入った人・管理者) の判定と起動は Concordia が持つ。
 *
 * @implements SPEC-USAGE-BUDGET-SUSPEND
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type ButtonInteraction } from "discord.js";

export const BUDGET_RESUME_PREFIX = "budget:resume:";

const ERROR_TEXT: Record<string, string> = {
  resume_not_allowed: "再開できるのは、中断したセッションを起動した人・指示を出した人・管理者だけです。",
  budget_still_exhausted: "予算がまだ戻っていません。",
  already_resumed: "このセッションはすでに再開されています。",
  not_suspended: "このセッションは予算切れで中断していません。",
  conversation_unknown: "会話の記録が見つからないため再開できません。",
  resume_requires_claude: "このセッションの種類は再開に対応していません。",
};

export function budgetResumeCustomId(sessionId: string): string {
  return `${BUDGET_RESUME_PREFIX}${sessionId}`;
}

/** スレッドへ出す知らせ (本文と「再開」ボタン)。 */
export function budgetResumeMessage(sessionId: string, text: string) {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(budgetResumeCustomId(sessionId)).setLabel("再開").setStyle(ButtonStyle.Primary),
  );
  return { content: `💰 ${text}`, components: [row], allowedMentions: { parse: [] as never[] } };
}

/** 再開 API の応答を、 押した人だけに見せる文面にする。 */
export function budgetResumeReplyText(ok: boolean, error: string | null): string {
  if (ok) return "✅ 中断した作業を再開しました。新しいセッションが起動します。";
  return `⚠️ ${(error && ERROR_TEXT[error]) ?? `再開できませんでした (${error ?? "unknown"})。`}`;
}

export async function handleBudgetResumeButton(
  interaction: ButtonInteraction,
  deps: { concordiaUrl: string; fetchImpl?: typeof fetch },
): Promise<void> {
  const sessionId = interaction.customId.slice(BUDGET_RESUME_PREFIX.length).trim();
  if (!sessionId) {
    await interaction.reply({ content: budgetResumeReplyText(false, "not_suspended"), ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${deps.concordiaUrl.replace(/\/$/, "")}/v1/usage-budgets/suspensions/${encodeURIComponent(sessionId)}/resume`;
  const response = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actor_user_id: interaction.user.id }),
  }).catch(() => null);
  const payload = response ? await response.json().catch(() => ({})) as { error?: string } : { error: "concordia_unreachable" };
  await interaction.editReply({ content: budgetResumeReplyText(Boolean(response?.ok), payload.error ?? null) });
}

export interface BudgetResumableDeliveryDeps {
  /** セッションのスレッド。 無ければ null (出さない)。 */
  channelIdForSession(sessionId: string): string | null;
  send(channelId: string, message: ReturnType<typeof budgetResumeMessage>): Promise<void>;
  log: { warn(message: string): void };
}

/** 予算が戻った知らせをセッションのスレッドへ出す (best-effort)。 */
export async function deliverBudgetResumable(
  deps: BudgetResumableDeliveryDeps,
  event: { session_id: string; text: string },
): Promise<void> {
  const channelId = deps.channelIdForSession(event.session_id);
  if (!channelId) {
    deps.log.warn(`budget resume offer skipped: no channel session=${event.session_id}`);
    return;
  }
  try {
    await deps.send(channelId, budgetResumeMessage(event.session_id, event.text));
  } catch (error) {
    deps.log.warn(`budget resume offer delivery failed session=${event.session_id}: ${(error as Error).message}`);
  }
}
