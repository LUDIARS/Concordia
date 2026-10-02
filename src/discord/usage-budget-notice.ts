/**
 * 月次予算の閾値の知らせを Discord へ届ける (spec/feature/usage-budgets.md §5)。
 *
 * - ユーザー: 本社 Bot だけが本人へ DM する (子会社 Bot と二重に送らない)。
 * - チーム: そのチームを持つ Bot が、 チームのコスト面へ投稿する。
 * どちらも best-effort。 届かなかった事実はログに残す (本文は予算の数値だけで、 個人の情報を含まない)。
 *
 * @implements SPEC-USAGE-BUDGET-NOTICE
 */

export interface UsageBudgetNoticeEvent {
  scope: "user" | "team";
  target_id: string;
  text: string;
}

export interface UsageBudgetNoticeDeps {
  /** この Bot が本社か。 */
  isHeadOffice: boolean;
  sendDirectMessage(userId: string, text: string): Promise<void>;
  /** この Bot が持つチームのコスト面。 持たない・未作成なら null。 */
  teamCostChannelId(teamId: string): string | null;
  sendToChannel(channelId: string, text: string): Promise<void>;
  log: { warn(message: string): void };
}

export async function deliverUsageBudgetNotice(deps: UsageBudgetNoticeDeps, event: UsageBudgetNoticeEvent): Promise<void> {
  const text = `💰 ${event.text}`;
  try {
    if (event.scope === "user") {
      if (!deps.isHeadOffice) return;
      await deps.sendDirectMessage(event.target_id, text);
      return;
    }
    const channelId = deps.teamCostChannelId(event.target_id);
    if (!channelId) return;
    await deps.sendToChannel(channelId, text);
  } catch (error) {
    deps.log.warn(`usage budget notice delivery failed scope=${event.scope}: ${(error as Error).message}`);
  }
}

/** admin spawn が予算切れで断ったときのエラーから、 本人に見せる文面を取り出す。 */
export function budgetRefusalText(error: string): string | null {
  const prefix = "budget_exhausted: ";
  return error.startsWith(prefix) ? error.slice(prefix.length) : null;
}
