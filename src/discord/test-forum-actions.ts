/**
 * テストフォーラム操作面の副作用 (実行設定の永続化 / セッション起動 / マージ)。
 * @implements spec/feature/test-forum-controls.md — 実装範囲・権限
 */
import type { ButtonInteraction, StringSelectMenuInteraction } from "discord.js";
import type { DiscordTestSurfaceRow, DiscordTestSurfacesRepo } from "../db/discord-test-surfaces-repo.js";
import type { RevisorLocalPrMerger, RevisorLocalPrReader } from "../pr/revisor-client.js";
import { callConcordia } from "./commands/_util.js";
import { isEffortSupported, parseProviderChoice, type TestControlAction } from "./test-forum-controls.js";
import { renderTestForumControls } from "./test-forum-discord.js";

export interface TestForumActionDeps {
  concordiaUrl: string;
  surfaces: DiscordTestSurfacesRepo;
  revisor: RevisorLocalPrReader & RevisorLocalPrMerger;
  isLaunchUserAllowed?: (userId: string) => boolean;
  isMergeUserAllowed?: (userId: string) => boolean;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

/** test: 名前空間だけを処理し、既存 ctrl: 操作と状態・権限を混ぜない。 */
export async function handleTestForumControl(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  control: { action: TestControlAction; surfaceId: number },
  deps: TestForumActionDeps,
): Promise<void> {
  const surface = deps.surfaces.findOpen(control.surfaceId);
  if (!surface) {
    await interaction.reply({ content: "このテスト候補は既に閉じられたため操作できません。", ephemeral: true });
    return;
  }
  // customId の action と component 種別は描画側で 1 対 1 だが、 古いメッセージ由来の
  // 取り違えを無言の実行時エラーにしない (cast ではなく型ガードで振り分ける)。
  if (control.action === "provider" || control.action === "effort") {
    if (!interaction.isStringSelectMenu()) {
      await interaction.reply({ content: "この操作面は古い形式です。投稿を更新してからやり直してください。", ephemeral: true });
      return;
    }
    await updateConfig(interaction, control.action, surface, deps);
    return;
  }
  if (!interaction.isButton()) {
    await interaction.reply({ content: "この操作面は古い形式です。投稿を更新してからやり直してください。", ephemeral: true });
    return;
  }
  if (control.action === "start") {
    await startTest(interaction, surface, deps);
    return;
  }
  await mergeTest(interaction, surface, deps);
}

async function updateConfig(
  interaction: StringSelectMenuInteraction,
  action: "provider" | "effort",
  surface: DiscordTestSurfaceRow,
  deps: TestForumActionDeps,
): Promise<void> {
  if (surface.run_state !== "candidate") {
    await interaction.reply({ content: "テスト開始後は実行設定を変更できません。", ephemeral: true });
    return;
  }
  // 実行設定はそのまま特権 spawn の引数になる。 起動と同じ capability で守り、
  // 権限 check が未配線なら fail-closed にする (spec/feature/test-forum-controls.md §5)。
  if (deps.isLaunchUserAllowed?.(interaction.user.id) !== true) {
    await interaction.reply({ content: "実行設定の変更は社員名簿の管理職以上だけが行えます。", ephemeral: true });
    return;
  }
  const value = interaction.values[0] ?? "";
  if (action === "provider") {
    const config = parseProviderChoice(value);
    // provider を跨ぐと effort 語彙も変わる。 新 provider で無効な値は、 その
    // provider の既定へ寄せる (無効値のまま spawn 引数へ渡さない)。
    const effort = isEffortSupported(config.provider, surface.effort) ? surface.effort : config.effort;
    deps.surfaces.updateRunConfig(surface.id, { provider: config.provider, model: config.model, effort });
  } else if (isEffortSupported(surface.provider, value)) {
    deps.surfaces.updateRunConfig(surface.id, { provider: surface.provider, model: surface.model, effort: value });
  } else {
    await interaction.reply({ content: "未知の effort 値のため設定を変更しませんでした。", ephemeral: true });
    return;
  }
  const updated = deps.surfaces.findOpen(surface.id);
  if (!updated) throw new Error(`test surface disappeared while updating: ${surface.id}`);
  await interaction.update(renderTestForumControls(updated));
}

/**
 * surface の実行設定でテストセッションの起動を要求する。 起動点はボタンと
 * スレッド内のユーザ投稿の両方 (test-forum-message.ts)。 instruction は
 * ユーザ投稿の本文 (あれば起動プロンプトへ指示として載せる)。
 */
export async function requestTestSpawn(
  surface: DiscordTestSurfaceRow,
  deps: Pick<TestForumActionDeps, "concordiaUrl">,
  instruction?: string,
): Promise<{ ok: true; pid: number | null } | { ok: false; error: string }> {
  if (!surface.repo_root_path || !surface.head_branch) {
    return { ok: false, error: "確認対象のrepository rootまたはbranchを解決できません。" };
  }
  const prompt = `## Test forum verification\nRevisor local PR ${surface.repo_origin}#${surface.pr_number} の確認を行ってください。`
    + (instruction ? `\n\nユーザからの指示:\n${instruction}` : "");
  const result = await callConcordia<{ ok: boolean; pid?: number; error?: string }>(
    deps.concordiaUrl,
    "POST",
    "/v1/admin/spawn-session",
    {
      provider: surface.provider,
      model: surface.model || undefined,
      cwd: surface.repo_root_path,
      branch: surface.head_branch,
      worktree: true,
      // effort の読み取りキーは provider レーンごとに違う (control/provider-preset.ts:
      // claude は `effort`、codex 系は `model_reasoning_effort`)。 取り違えると選択が
      // 無言で捨てられ、 投稿の表示と実際の実行設定が食い違う。
      options: surface.provider === "claude"
        ? { effort: surface.effort }
        : { model_reasoning_effort: surface.effort },
      test_surface_id: surface.id,
      prompt,
    },
  );
  if ("error" in result || !result.ok) {
    return { ok: false, error: ("error" in result ? result.error : undefined) ?? "unknown" };
  }
  return { ok: true, pid: result.pid ?? null };
}

async function startTest(
  interaction: ButtonInteraction,
  surface: DiscordTestSurfaceRow,
  deps: TestForumActionDeps,
): Promise<void> {
  if (surface.run_state !== "candidate") {
    await interaction.reply({ content: "この候補は既にテスト開始済みです。", ephemeral: true });
    return;
  }
  if (deps.isLaunchUserAllowed?.(interaction.user.id) !== true) {
    await interaction.reply({ content: "テスト開始は社員名簿の管理職以上だけが実行できます。", ephemeral: true });
    return;
  }
  if (!surface.repo_root_path || !surface.head_branch) {
    await interaction.reply({ content: "確認対象のrepository rootまたはbranchを解決できません。", ephemeral: true });
    return;
  }
  await interaction.deferUpdate();
  const result = await requestTestSpawn(surface, deps);
  if (!result.ok) {
    deps.log.warn(`test-forum start failed surface=${surface.id}: ${result.error}`);
    await interaction.followUp({ content: `テスト開始に失敗しました: ${result.error}`, ephemeral: true });
    return;
  }
  // session_id は Lictor の session.started 到着後に確定する。先に状態を変えると、失敗時に
  // 二度と再実行できなくなるため、ここでは「開始要求済み」をスレッドへ明示するだけに留める。
  await interaction.followUp({ content: `テスト起動を受け付けました (pid: ${result.pid ?? "n/a"})。セッション登録後に操作面を更新します。`, ephemeral: true });
}

async function mergeTest(
  interaction: ButtonInteraction,
  surface: DiscordTestSurfaceRow,
  deps: TestForumActionDeps,
): Promise<void> {
  if (surface.run_state !== "testing") {
    await interaction.reply({ content: "テスト開始済みの候補だけをマージできます。", ephemeral: true });
    return;
  }
  if (deps.isMergeUserAllowed?.(interaction.user.id) !== true) {
    await interaction.reply({ content: "マージは社員名簿の管理職以上だけが実行できます。", ephemeral: true });
    return;
  }
  await interaction.deferUpdate();
  try {
    const local = surface.local_pr_id
      ? null
      : (await deps.revisor.listLocalPrs()).find((pr) => pr.repository === surface.repo_origin && pr.number === surface.pr_number);
    const localPrId = surface.local_pr_id ?? local?.id;
    if (!localPrId) throw new Error("Revisor の local PR を repo と PR 番号から解決できませんでした");
    if (!surface.local_pr_id) deps.surfaces.setLocalPrId(surface.id, localPrId);
    await deps.revisor.mergeLocalPr(localPrId);
    deps.surfaces.markMerged(surface.id);
    const updated = deps.surfaces.findOpen(surface.id);
    if (!updated) throw new Error("マージ後のテスト候補を取得できませんでした");
    await interaction.editReply(renderTestForumControls(updated));
  } catch (error) {
    const detail = (error as Error).message;
    deps.log.warn(`test-forum merge failed surface=${surface.id}: ${detail}`);
    await interaction.followUp({ content: `マージに失敗しました: ${detail}`, ephemeral: true });
  }
}
