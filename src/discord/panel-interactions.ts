/**
 * 操作パネル (PR 提出・マージ / RWF アクション選択) のインタラクション処理。
 *
 * 描画は `pr-panel.ts` / `rwf-panel.ts` (どちらも `interaction-ui.ts` 経由) に任せ、
 * ここは「押された customId をどの処理へ渡すか」だけを持つ。 PR の提出・マージは
 * リアクション経由と同じ `SessionPrPort` を呼ぶので、 実処理は二重に無い。
 *
 * @implements spec/feature/workflow-toggles-and-permission-noise.md — W2 / W4
 */

import type { ButtonInteraction, Interaction, StringSelectMenuInteraction } from "discord.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { RwfPrActor } from "../platform/reaction-workflow-pr.js";
import type { SessionPrPort } from "../pr/session-pr-operations.js";
import { getRwf } from "../platform/reaction-workflow-loader.js";
import { isWorkflowAction, type WorkflowAction } from "../platform/reaction-workflow.js";
import type { ReactionWorkflowInput, WorkflowResultRelay } from "../platform/reaction-workflow.js";
import {
  buildPrMergeResultPanel,
  buildPrOperationPanel,
  buildPrSubmitResultPanel,
  parsePrPanelId,
  type PrPanelState,
} from "./pr-panel.js";
import { buildRwfAckPanel, buildRwfActionSelectPanel, parseRwfPanelId } from "./rwf-panel.js";
import { resolveReactionSessionContext, type SessionLookup } from "./reactions.js";

/** マージ対象の同定に必要なセッション行 (SessionsRepo の部分)。 */
export interface PanelSessionLookup extends SessionLookup {
  findSession(sessionId: string): {
    repo_path: string;
    status: string;
    repo_origin: string | null;
    branch: string | null;
  } | null;
}

export interface PanelInteractionDeps {
  sessionChannelsRepo?: DiscordSessionChannelsRepo;
  sessionsRepo?: PanelSessionLookup;
  /** PR 提出 / マージの実体。 未注入なら操作面は「使えない」と明示して返す。 */
  prOperations?: SessionPrPort;
  /** PR のマージ権限 (`merge_pr`)。 未注入は deny (fail-closed)。 */
  isMergeUserAllowed?: (userId: string) => boolean;
  /** RWF の実行口 (絵文字リアクションと同じ経路)。 */
  reactionWorkflow?: {
    handle(
      input: ReactionWorkflowInput,
      onAccept?: (action: WorkflowAction) => void,
      onResult?: (action: WorkflowAction, result: WorkflowResultRelay) => void,
    ): Promise<void>;
  };
  log: { info: (message: string) => void; warn: (message: string) => void };
}

/** この interaction が操作パネル由来か (dispatcher の分岐用)。 */
export function isPanelInteraction(interaction: Interaction): boolean {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return false;
  return parsePrPanelId(interaction.customId) !== null || parseRwfPanelId(interaction.customId) !== null;
}

/** 操作パネルのボタン / 選択を処理する。 該当しない customId は false を返して素通しする。 */
export async function handlePanelInteraction(
  interaction: Interaction,
  deps: PanelInteractionDeps,
): Promise<boolean> {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return false;

  const pr = parsePrPanelId(interaction.customId);
  if (pr) {
    await handlePrPanel(interaction, deps, pr.action, pr.sessionId);
    return true;
  }
  const rwf = parseRwfPanelId(interaction.customId);
  if (rwf) {
    await handleRwfPanel(interaction, deps, rwf.action, rwf.targetMessageId);
    return true;
  }
  return false;
}

async function handlePrPanel(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  deps: PanelInteractionDeps,
  action: "submit" | "merge" | "select",
  sessionId: string,
): Promise<void> {
  const operations = deps.prOperations;
  if (!operations) {
    await replyText(interaction, "PR 操作はこの構成では有効になっていません (prOperations 未注入)。");
    return;
  }
  const actor: RwfPrActor = { userId: interaction.user.id };
  const state = await loadPrPanelState(operations, deps, sessionId);

  if (action === "submit") {
    const outcome = await operations.submitLocalPr({ sessionId, actor });
    deps.log.info(`pr-panel: submit session=${sessionId.slice(0, 8)} actor=${actor.userId} kind=${outcome.kind}`);
    await replyPanel(interaction, buildPrSubmitResultPanel(state, outcome, actor));
    return;
  }

  // マージは破壊的操作。 押した本人の役職で判定する (パネルを見られる = 権限ではない)。
  if (deps.isMergeUserAllowed?.(actor.userId) !== true) {
    deps.log.warn(`pr-panel: merge denied user=${actor.userId} session=${sessionId.slice(0, 8)}`);
    await replyText(
      interaction,
      "PR のマージには社員名簿の merge_pr 権限 (管理職以上) が必要です。",
    );
    return;
  }

  const outcome = action === "select"
    ? await operations.mergeSelectedLocalPr({
      sessionId,
      localPrId: selectedValue(interaction),
      actor,
    })
    : await operations.mergeLocalPr({ sessionId, actor });
  deps.log.info(`pr-panel: merge session=${sessionId.slice(0, 8)} actor=${actor.userId} kind=${outcome.kind}`);
  await replyPanel(interaction, buildPrMergeResultPanel(state, outcome, actor));
}

async function handleRwfPanel(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  deps: PanelInteractionDeps,
  action: "choose" | "actions" | "pr-panel",
  targetMessageId: string,
): Promise<void> {
  if (action === "actions") {
    await replyPanel(interaction, buildRwfActionSelectPanel({ targetMessageId }));
    return;
  }

  const context = resolveReactionSessionContext(
    { sessionChannels: deps.sessionChannelsRepo, sessions: deps.sessionsRepo },
    interaction.channelId,
  );

  if (action === "pr-panel") {
    if (!context.sessionId || !deps.prOperations) {
      await replyText(
        interaction,
        context.sessionId
          ? "PR 操作はこの構成では有効になっていません (prOperations 未注入)。"
          : "このチャンネルはセッションチャンネルではないため、PR 操作パネルを出せません。",
      );
      return;
    }
    const state = await loadPrPanelState(deps.prOperations, deps, context.sessionId);
    await replyPanel(interaction, buildPrOperationPanel(state));
    return;
  }

  // choose: 選ばれたワークフローを、 絵文字リアクションと同じ経路で実行する。
  const selected = selectedValue(interaction);
  if (!isWorkflowAction(selected)) {
    await replyText(interaction, `未知のワークフローです: ${selected}`);
    return;
  }
  if (!deps.reactionWorkflow) {
    await replyText(interaction, "リアクションワークフローがこの構成では有効になっていません。");
    return;
  }

  const target = await fetchTargetMessage(interaction, targetMessageId);
  const emoji = getRwf().primaryEmojiForAction?.(selected) ?? "";
  await replyPanel(interaction, buildRwfAckPanel({
    action: selected,
    emoji,
    targetMessageId,
    actorId: interaction.user.id,
  }));
  void deps.reactionWorkflow
    .handle(
      {
        dedupeKey: targetMessageId,
        emoji,
        userId: interaction.user.id,
        messageText: target?.content ?? "",
        authorLabel: target?.authorLabel ?? "unknown",
        repoPath: context.repoPath,
        sessionActive: context.sessionActive,
        sessionId: context.sessionId,
      },
      undefined,
      (workflowAction, result) => {
        void interaction
          .followUp({ content: `${result.ok ? "✅" : "⚠️"} ${workflowAction}\n${result.text}`, ephemeral: true })
          .catch((e) => deps.log.info(`rwf-panel: result follow-up failed: ${(e as Error).message}`));
      },
    )
    .catch((e) => deps.log.warn(`rwf-panel: workflow failed: ${(e as Error).message}`));
}

async function loadPrPanelState(
  operations: SessionPrPort,
  deps: PanelInteractionDeps,
  sessionId: string,
): Promise<Omit<PrPanelState, "result">> {
  const session = deps.sessionsRepo?.findSession(sessionId) ?? null;
  let openPullRequests: PrPanelState["openPullRequests"] = [];
  try {
    openPullRequests = (await operations.listOpenLocalPrs(sessionId)).map((pr) => ({
      id: pr.id,
      number: pr.number,
      repository: pr.repository,
      headRef: pr.headRef,
    }));
  } catch (e) {
    // 一覧が取れなくても提出 / マージ操作は出す (Revisor 停止中に操作面ごと消さない)。
    deps.log.warn(`pr-panel: local PR listing failed: ${(e as Error).message}`);
  }
  return {
    sessionId,
    branch: session?.branch ?? null,
    repository: session?.repo_origin ?? null,
    openPullRequests,
  };
}

function selectedValue(interaction: ButtonInteraction | StringSelectMenuInteraction): string {
  return interaction.isStringSelectMenu() ? interaction.values[0] ?? "" : "";
}

async function fetchTargetMessage(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  messageId: string,
): Promise<{ content: string; authorLabel: string } | null> {
  const channel = interaction.channel;
  if (!channel || !("messages" in channel)) return null;
  try {
    const message = await channel.messages.fetch(messageId);
    return { content: message.content ?? "", authorLabel: message.author?.username ?? "unknown" };
  } catch {
    return null;
  }
}

async function replyPanel(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  panel: { embeds: unknown[]; components: unknown[] },
): Promise<void> {
  await interaction.reply({
    ...(panel as { embeds: never[]; components: never[] }),
    ephemeral: true,
  });
}

async function replyText(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  content: string,
): Promise<void> {
  await interaction.reply({ content, ephemeral: true });
}
