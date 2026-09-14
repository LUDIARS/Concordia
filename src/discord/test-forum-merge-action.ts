/**
 * テストフォーラムのマージ操作 (Cc 所有の構造化操作。 認可と Revisor 呼び出しは LLM セッションに入れない)。
 *
 * 受付 (DB の条件付き更新) と押された投稿のボタン除去を、長い Revisor マージ API より先に行う。
 * 結果 (完了 / 失敗 / 結果不明) はスレッドへ通常メッセージで残す。 マージの成否は Revisor の
 * 応答と実状態で決め、その後の Discord 更新の失敗をマージの失敗として扱わない。
 * 応答喪失を失敗確定や再実行許可へ変換しない (CC-INV-03 / CC-NODE-03)。
 * @implements spec/feature/test-forum-controls.md — マージの受付と結果通知
 */
import type { ButtonInteraction } from "discord.js";
import type { DiscordTestSurfaceRow, DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type { RevisorLocalPr, RevisorLocalPrMerger, RevisorLocalPrReader } from "../pr/revisor-client.js";
import { findLocalPrById } from "../pr/revisor-merge-confirm.js";
import {
  classifyMergeFailure,
  RevisorMergeError,
  type RevisorMergeFailureReason,
} from "../pr/revisor-merge-outcome.js";
import { isMergeAllowedState } from "./test-forum-controls.js";
import {
  createTestForumSurfaceUi,
  mergeButtonRows,
  renderTestForumControls,
  type TestForumSurfaceUi,
} from "./test-forum-discord.js";
import {
  MERGE_ACCEPTED_REPLY,
  MERGE_IN_PROGRESS_REPLY,
  mergeFailedNotice,
  mergeSucceededNotice,
  mergeUnknownDetail,
  mergeUnknownNotice,
  type MergeCompletion,
} from "./test-forum-merge-messages.js";

export interface TestForumMergeDeps {
  surfaces: DiscordTestSurfacesRepo;
  revisor: RevisorLocalPrReader & RevisorLocalPrMerger;
  isMergeUserAllowed?: (userId: string) => boolean;
  /** スレッドへの通知と操作面の更新。 省略時は interaction の guild から組み立てる。 */
  surfaceUi?: TestForumSurfaceUi;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

type MergeOutcome =
  | { kind: "merged"; how: MergeCompletion }
  /** Revisor がマージを実行していない根拠がある。 受付を戻してよい。 */
  | { kind: "failed"; detail: string }
  /** 実行されたかを否定できない。 受付を保持する。 */
  | { kind: "unknown"; detail: string };

/**
 * Revisor が要求を処理する前に断ったと言える分類。 認可拒否と、Revisor の 409 契約で
 * 識別できた拒否だけ。 打ち切り・到達失敗・未分類の失敗は含めない。
 */
const REJECTED_BEFORE_MERGE: ReadonlySet<RevisorMergeFailureReason> = new Set([
  "unauthorized",
  "conflict",
  "gate_not_passed",
  "not_open",
]);

function stateRejection(surface: DiscordTestSurfaceRow | null): string | null {
  if (!surface) return "このテスト候補は既に閉じられたため操作できません。";
  if (surface.check_status !== "test_ok") return "この候補は Test OK ではないためマージできません。";
  if (isMergeAllowedState(surface.run_state)) return null;
  if (surface.run_state === "merged") return "この候補は既にマージ済みです。";
  if (surface.run_state === "merging") return MERGE_IN_PROGRESS_REPLY;
  return "テストセッションの起動中はマージできません。起動が確定してからやり直してください。";
}

function findTarget(surface: DiscordTestSurfaceRow, pullRequests: readonly RevisorLocalPr[]): RevisorLocalPr | null {
  return pullRequests.find((pr) => (surface.local_pr_id
    ? pr.id === surface.local_pr_id
    : pr.repository === surface.repo_origin && pr.number === surface.pr_number)) ?? null;
}

/** Revisor の応答と実状態からマージ結果を確定する。 Discord には触れない。 */
async function runMerge(surface: DiscordTestSurfaceRow, deps: TestForumMergeDeps): Promise<MergeOutcome> {
  // 要求の直前に実状態を読む。 読めない・対象が無い・open でない場合、マージは要求しない。
  let pullRequests: RevisorLocalPr[];
  try {
    pullRequests = await deps.revisor.listLocalPrs();
  } catch {
    return { kind: "failed", detail: "Revisor に local PR の状態を問い合わせられませんでした。マージは要求していません。" };
  }
  const target = findTarget(surface, pullRequests);
  if (!target) {
    return { kind: "failed", detail: "Revisor の local PR を repo と PR 番号から解決できませんでした。マージは要求していません。" };
  }
  if (!surface.local_pr_id) deps.surfaces.setLocalPrId(surface.id, target.id);
  if (target.status === "merged") return { kind: "merged", how: "already_merged" };
  if (target.status !== "open") {
    return { kind: "failed", detail: "Revisor でこの local PR は open ではないため、マージは要求していません。" };
  }
  try {
    await deps.revisor.mergeLocalPr(target.id);
    return { kind: "merged", how: "merged" };
  } catch (error) {
    const failure = classifyMergeFailure(error);
    // Revisor の原文は機密を含み得るため、分類と status だけを記録する。
    const status = error instanceof RevisorMergeError ? error.status ?? "none" : "none";
    deps.log.warn(`test-forum merge request failed surface=${surface.id} reason=${failure.reason} status=${status}`);
    if (failure.reason === "already_merged") return { kind: "merged", how: "already_merged" };
    if (REJECTED_BEFORE_MERGE.has(failure.reason)) return { kind: "failed", detail: failure.detail };
    // 応答喪失・到達失敗・未分類の失敗では Revisor が処理を続けている可能性を否定できない。
    // マージ済みを読めた場合だけ確定し、それ以外は結果不明として受付を残す。
    const current = await findLocalPrById(deps.revisor, target.id);
    if (current?.status === "merged") return { kind: "merged", how: "confirmed" };
    return { kind: "unknown", detail: mergeUnknownDetail(failure.reason) };
  }
}

export async function mergeTest(
  interaction: ButtonInteraction,
  surface: DiscordTestSurfaceRow,
  deps: TestForumMergeDeps,
): Promise<void> {
  const rejection = stateRejection(surface);
  if (rejection) {
    await interaction.reply({ content: rejection, ephemeral: true });
    return;
  }
  if (deps.isMergeUserAllowed?.(interaction.user.id) !== true) {
    await interaction.reply({ content: "マージは社員名簿の管理職以上だけが実行できます。", ephemeral: true });
    return;
  }
  // 受付は DB の条件付き更新で 1 件に絞る。 同時クリック・操作面と通知の両方のボタン・
  // 同期中の再押下でも、Revisor へのマージ要求は 1 回しか出ない。
  if (!deps.surfaces.claimMerge(surface.id)) {
    const current = deps.surfaces.findOpen(surface.id);
    await interaction.reply({
      content: stateRejection(current) ?? "この候補は現在マージを受け付けられません。",
      ephemeral: true,
    });
    return;
  }
  const claimed = deps.surfaces.findOpen(surface.id) ?? { ...surface, run_state: "merging" as const };
  const pressedControls = interaction.message.id === claimed.controls_message_id;
  try {
    // 受付応答そのものでボタンを外す。 通知の投稿は審査結果の記録なので、ボタンだけを外す。
    await interaction.update(pressedControls ? renderTestForumControls(claimed) : { components: [] });
  } catch (error) {
    // Revisor へはまだ何も要求していない。 受付を示せなかった操作は実行せず、再操作できるよう戻す。
    deps.surfaces.releaseMerge(surface.id);
    deps.log.warn(`test-forum merge acknowledgement failed surface=${surface.id}: ${(error as Error).message}`);
    return;
  }

  const ui = deps.surfaceUi ?? (interaction.guild ? createTestForumSurfaceUi(interaction.guild) : null);
  const bestEffort = async (label: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      deps.log.warn(`test-forum merge ${label} failed surface=${surface.id}: ${(error as Error).message}`);
    }
  };
  const userId = interaction.user.id;
  // 押されていない側 (操作面) のボタンもマージ要求と並行して外し、受付を押した本人へ知らせる。
  const accepted = Promise.all([
    !pressedControls && claimed.controls_message_id && ui
      ? bestEffort("controls hide", () => ui.refreshControls(claimed))
      : Promise.resolve(),
    bestEffort("acceptance reply", () => interaction.followUp({ content: MERGE_ACCEPTED_REPLY, ephemeral: true })),
  ]);
  const outcome = await runMerge(claimed, deps);
  await accepted;
  if (!ui) deps.log.warn(`test-forum merge thread notices unavailable surface=${surface.id}: guild is missing`);

  if (outcome.kind === "merged") {
    // マージの記録を先に確定させる。 以降の Discord 更新の失敗はマージ結果を変えない。
    deps.surfaces.markMerged(surface.id);
    deps.log.info(`test-forum merge completed surface=${surface.id} outcome=${outcome.how}`);
    const merged = deps.surfaces.findOpen(surface.id);
    if (ui) {
      await bestEffort("completion notice", () =>
        ui.postNotice(merged ?? claimed, mergeSucceededNotice(surface.pr_number, userId, outcome.how)));
      if (merged?.controls_message_id) await bestEffort("controls refresh", () => ui.refreshControls(merged));
    }
    return;
  }
  if (outcome.kind === "unknown") {
    // 受付は残す。 Revisor で merged / closed に決着すれば同期がスレッドを閉じる。
    deps.log.warn(`test-forum merge outcome unknown surface=${surface.id}; keeping the merge claim`);
    if (ui) {
      await bestEffort("unknown notice", () =>
        ui.postNotice(claimed, mergeUnknownNotice(surface.pr_number, userId, outcome.detail)));
    }
    return;
  }
  deps.surfaces.releaseMerge(surface.id);
  const released = deps.surfaces.findOpen(surface.id) ?? claimed;
  if (ui) {
    await bestEffort("failure notice", () =>
      ui.postNotice(released, mergeFailedNotice(surface.pr_number, userId, outcome.detail)));
  }
  if (released.check_status !== "test_ok" || !isMergeAllowedState(released.run_state)) return;
  await bestEffort("pressed controls restore", () => interaction.editReply(pressedControls
    ? renderTestForumControls(released)
    : { components: mergeButtonRows(released.id) }));
  if (!pressedControls && released.controls_message_id && ui) {
    await bestEffort("controls restore", () => ui.refreshControls(released));
  }
}
