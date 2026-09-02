import type { DelegationTemplateLite } from "./delegation-template-cache.js";
import type { ForumProjectTarget } from "./forum-project-code.js";
import { isProjectNameInScope } from "../subsidiary/project-scope.js";
import { SESSION_RUNTIME_RULE_TAG_NAMES } from "./forum-template-tags.js";
import { callConcordia } from "./commands/_util.js";
import type { ForumDelegationSelectionInput, ForumDelegationSelection } from "./forum-delegation-selector.js";
import {
  hasConcordiaManagedForumTag,
  type ForumTagIdentity,
  type ForumTagState,
} from "./forum-system-tag.js";
import {
  detectMissingForumSpawnInfo,
  forumSpawnIntakeGiveUpMessage,
  type ForumSpawnMissingField,
} from "./forum-spawn-intake.js";

const FORUM_SPAWN_TRIGGER_PREFIX = "discord-forum";

export interface ForumSpawnThread {
  id: string;
  guildId: string;
  parentId: string | null;
  ownerId: string | null;
  name: string;
  appliedTags: readonly string[];
  availableTags: readonly ForumTagIdentity[];
  fetchStarterMessage: () => Promise<{ content: string } | null>;
  fetchTagState: () => Promise<ForumTagState>;
}

/** Exact title/body approved for an otherwise unauthorized forum spawn. */
export interface ApprovedForumSpawnContent {
  readonly title: string;
  readonly body: string;
  readonly tagState: ForumTagState;
}

/**
 * spawn 実行部へ渡す投稿内容の差し替え。 承認経路はタグ状態まで固定するが、
 * 不足情報の回答経路は本文だけを補完し、タグは実行時に取り直す (回答の間に
 * 付け替えられたタグを取りこぼさないため)。
 */
export type ForumSpawnResult =
  | { ok: true }
  | { ok: false; error: string };

export interface SuppliedForumSpawnContent {
  readonly title: string;
  readonly body: string;
  readonly tagState?: ForumTagState;
  /** 不足情報の回答 (テンプレ選択メニュー) で確定した起動テンプレ。 selector を通さず使う。 */
  readonly template?: string;
}

export function matchesApprovedForumContent(
  title: string,
  starterContent: string,
  appliedTags: readonly string[],
  approved: ApprovedForumSpawnContent,
): boolean {
  const approvedTags = approved.tagState.appliedTags;
  return title === approved.title
    && starterContent.trim() === approved.body
    && appliedTags.length === approvedTags.length
    && appliedTags.every((tag) => approvedTags.includes(tag));
}

export interface ForumSpawnDeps {
  sessionForumId: string;
  botUserId: string;
  concordiaUrl: string;
  /**
   * このスレッドを処理している Bot インスタンス自身の子会社 (subsidiary) id。
   * 本社 Bot なら null。 spawn したセッションの metadata.subsidiary_id へ焼き込むために
   * `/v1/admin/spawn-session` へ転送する (未指定だと子会社 Bot 経由の forum spawn が本社
   * セッションとして誤帰属し、 本社/子会社の可視範囲判定 (ownsSession) が壊れる)。
   */
  subsidiaryId?: string | null;
  templates: () => Promise<DelegationTemplateLite[]>;
  /** `claude -p --model sonnet` による one-shot template selector。 */
  selectTemplate: (input: ForumDelegationSelectionInput) => Promise<ForumDelegationSelection>;
  resolveProjectTarget: (title: string, body: string) => ForumProjectTarget | null;
  /**
   * 子会社の関係プロジェクト (spec §3.4)。 `subsidiaryId` がある場合は必須で、 解決した
   * 対象プロジェクトがこの集合の外なら起動しない。 本社 Bot は指定しない (= 制限なし)。
   */
  resolveSubsidiaryProjects?: () => readonly string[];
  /** Exact Discord user ID authorization for the thread owner. */
  isLaunchUserAllowed?: (userId: string) => boolean;
  /**
   * 権限の無い投稿者のスレッドに「管理職以上が押すと起動する」承認カードを出す
   * (forum-spawn-approval.ts)。 未配線なら従来どおり平文 deny。
   */
  requestApproval?: (
    thread: ForumSpawnThread,
    content: ApprovedForumSpawnContent,
  ) => Promise<void>;
  /**
   * 子会社 Bot のみ: spawn 前に依頼本文を Sonnet ガード (subsidiary/gate.ts) へ通す。
   * 受付チャンネルと同じく「出張先からの人間の作業指示は必ずガードを通す」
   * (spec/feature/subsidiary-delegation.md §3.1) を forum spawn にも適用する。
   * ロック/予算超過/ガード失敗は ok:false で停止、有効な Sonnet deny 所見は
   * ok:true + advisoryText
   * (スレッドへ注記して起動は継続 — 起動判断は権限者のもの、2026-09-02 neco 指示)。
   * 未配線 (本社 Bot) はガード無しで従来どおり。
   */
  guardInstruction?: (input: { userId: string; userLabel: string; instruction: string })
    => Promise<{ ok: boolean; replyText: string; advisoryText?: string }>;
  /**
   * spawn に必要な情報 (関係プロジェクト / タスク内容) が投稿から取れないとき、
   * スレッド内で聞き返す (forum-spawn-intake.ts)。 質問を出せたら true。
   * 未配線なら従来どおり平文で不足を伝えて終わる。
   */
  requestIntake?: (input: {
    thread: ForumSpawnThread;
    requesterUserId: string;
    title: string;
    body: string;
    missing: readonly ForumSpawnMissingField[];
  }) => Promise<boolean>;
  hasExistingRun: (triggeredBy: string) => boolean;
  /** Cc の Forum 返信も必ず親 Forum webhook + thread_id で投稿する。 */
  postToThread: (threadId: string, content: string) => Promise<void>;
  /** Discord の ThreadCreate と starter message 作成競合を bounded retry するための差し替え口。 */
  wait?: (ms: number) => Promise<void>;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

export async function handleForumSpawnThread(deps: ForumSpawnDeps, thread: ForumSpawnThread): Promise<void> {
  if (thread.parentId !== deps.sessionForumId) return;
  if (hasConcordiaManagedForumTag(thread)) {
    deps.log.info(`forum-spawn Cc-managed thread ignored thread=${thread.id}`);
    return;
  }
  if (!thread.ownerId || thread.ownerId === deps.botUserId) return;
  if (deps.isLaunchUserAllowed?.(thread.ownerId) !== true) {
    deps.log.warn(`forum-spawn unauthorized owner=${thread.ownerId} thread=${thread.id}`);
    if (deps.requestApproval) {
      // 承認後の編集を実行対象に混ぜないよう、カード作成時のタイトルと本文を固定する。
      const starter = await fetchStarterWithRetry(thread, deps.wait);
      if (!starter) {
        await reply(deps, thread, "最初の投稿を取得できなかったため、承認を依頼できませんでした。");
        return;
      }
      const body = starter.content.trim();
      if (isConcordiaSessionStarter(body)) {
        deps.log.info(`forum-spawn webhook-created Session thread ignored thread=${thread.id}`);
        return;
      }
      let tagState: ForumTagState;
      try {
        tagState = await thread.fetchTagState();
      } catch (error) {
        deps.log.warn(`forum-spawn tag refresh failed before approval thread=${thread.id}: ${(error as Error).message}`);
        await reply(deps, thread, "Forum タグの最新状態を確認できなかったため、承認を依頼できませんでした。");
        return;
      }
      if (hasConcordiaManagedForumTag(tagState)) {
        deps.log.info(`forum-spawn explicit/Cc-managed thread ignored before approval thread=${thread.id}`);
        return;
      }
      await deps.requestApproval(thread, { title: thread.name, body, tagState });
      return;
    }
    await reply(deps, thread, "このユーザーにはセッション起動権限がありません。");
    return;
  }
  await executeForumSpawn(deps, thread);
}

/**
 * 権限確認より後の spawn 続行部。 再入口は 2 つ:
 *  - 承認ボタン (forum-spawn-approval.ts): 承認時点の投稿内容 + タグ状態を固定して渡す。
 *  - 不足情報の回答 (forum-spawn-intake.ts): 補完した本文だけを渡し、タグ状態は取り直す。
 * どちらも重複 run 判定 (triggered_by) が冪等性を守る。
 */
export async function executeForumSpawn(
  deps: ForumSpawnDeps,
  thread: ForumSpawnThread,
  suppliedContent?: SuppliedForumSpawnContent,
): Promise<ForumSpawnResult> {
  const triggeredBy = buildForumSpawnTrigger(thread.guildId, thread.id);
  if (deps.hasExistingRun(triggeredBy)) {
    deps.log.info(`forum-spawn duplicate ignored thread=${thread.id}`);
    return { ok: true };
  }

  let title = suppliedContent?.title;
  let body = suppliedContent?.body;
  if (title === undefined || body === undefined) {
    const starter = await fetchStarterWithRetry(thread, deps.wait);
    if (!starter) {
      await reply(deps, thread, "最初の投稿を取得できなかったため、セッションを起動できませんでした。");
      return { ok: false, error: "starter message unavailable" };
    }
    title = thread.name;
    body = starter.content.trim();
    if (isConcordiaSessionStarter(body)) {
      deps.log.info(`forum-spawn webhook-created Session thread ignored thread=${thread.id}`);
      return { ok: false, error: "Concordia-managed starter" };
    }
  }
  if (deps.guardInstruction) {
    // 子会社: 依頼本文をガード (ロック/予算/Sonnet 判定 + 監査記録) に通してから進む。
    const guarded = await deps.guardInstruction({
      userId: thread.ownerId ?? "",
      userLabel: thread.ownerId ? `<@${thread.ownerId}>` : "unknown",
      instruction: `${title}\n\n${body}`,
    });
    if (!guarded.ok) {
      deps.log.warn(`forum-spawn guarded deny thread=${thread.id} owner=${thread.ownerId ?? "-"}`);
      await reply(deps, thread, guarded.replyText);
      return { ok: false, error: "subsidiary guard denied the request" };
    }
    if (guarded.advisoryText) {
      // ガード所見は advisory: スレッドへ注記して起動は続ける。注記の投稿失敗で
      // spawn を止めない (所見は監査記録にも残っている)。
      try {
        await reply(deps, thread, guarded.advisoryText);
      } catch (error) {
        deps.log.warn(`forum-spawn advisory note post failed thread=${thread.id}: ${(error as Error).message}`);
      }
    }
  }
  const project = deps.resolveProjectTarget(title, body);
  // Session forum への投稿は「起動依頼」。 起動に要る情報が欠けていたら平文の拒否で
  // 終わらせず、 同じスレッドで聞き返す (2026-09-01 neco 指示 3)。
  const missing = detectMissingForumSpawnInfo({ body, projectResolved: project !== null });
  if (missing.length > 0 || !project) {
    // 権限の無い投稿者の起動承認は、カード作成時の exact content に対するもの。
    // 承認後に依頼者の回答を追記すると、未承認の作業内容で起動できてしまう。
    // 承認スナップショットが不完全な場合は内容の接ぎ足しを禁止し、完全な
    // 新規スレッドを改めて承認してもらう。
    if (suppliedContent?.tagState) {
      deps.log.warn(`forum-spawn approved content incomplete thread=${thread.id} fields=${missing.join(",")}`);
      await reply(deps, thread, forumSpawnIntakeGiveUpMessage(
        missing.length > 0 ? missing : (["project"] as const),
      ));
      return { ok: false, error: "approved content incomplete" };
    }
    await askForMissingForumSpawnInfo(deps, thread, { title, body, missing });
    return { ok: false, error: "missing information requested" };
  }
  const isSubsidiary = deps.subsidiaryId !== null && deps.subsidiaryId !== undefined;
  if (isSubsidiary && !deps.resolveSubsidiaryProjects) {
    // 子会社 id だけ配線されて scope resolver が欠けた構成を、本社相当の無制限として扱わない。
    deps.log.warn(`forum-spawn subsidiary project scope unavailable thread=${thread.id}`);
    await reply(deps, thread, "この窓口の担当プロジェクト設定を確認できないため起動しません。");
    return { ok: false, error: "subsidiary project scope unavailable" };
  }
  if (deps.resolveSubsidiaryProjects) {
    // 子会社は担当プロジェクト以外のスレッドから起動しない。 未設定 (空集合) も起動しない
    // — 「設定していない窓口は何でも起こせる」 を作らないため (spec §3.4)。
    const projects = deps.resolveSubsidiaryProjects();
    if (!isProjectNameInScope(project.project, projects)) {
      // project 設定は管理 API 入力なので、診断ログは JSON 化して改行によるログ偽装を防ぐ。
      deps.log.warn(
        `forum-spawn project out of subsidiary scope thread=${thread.id} `
        + `project=${JSON.stringify(project.project)} scope=${JSON.stringify(projects)}`,
      );
      await reply(
        deps,
        thread,
        "この窓口の担当範囲外のため起動しません。",
      );
      return { ok: false, error: "project out of subsidiary scope" };
    }
  }
  const templates = await deps.templates();
  let template: DelegationTemplateLite;
  if (suppliedContent?.template) {
    // 質問への回答で確定したテンプレは selector を通さない (回答が正)。
    const chosen = templates.find(
      (candidate) => candidate.call_name === suppliedContent.template
        && candidate.is_active && candidate.forum_tag === true,
    );
    if (!chosen) {
      // suppliedContent は interaction 境界から来る。未検証値をログ行や Discord の
      // Markdown へ直接反射せず、診断ログでは JSON 文字列化して改行を無害化する。
      deps.log.warn(
        `forum-spawn supplied template unavailable thread=${thread.id} `
        + `template=${JSON.stringify(suppliedContent.template)}`,
      );
      await reply(deps, thread, "選択された起動テンプレは利用できません。もう一度選択してください。");
      return { ok: false, error: "supplied template unavailable" };
    }
    template = chosen;
  } else {
    const selection = await deps.selectTemplate({ title, body, templates });
    if (!selection.ok) {
      // 起動テンプレ (モデル) を決められない場合も平文拒否で終わらせず、同じスレッドで
      // 質問形式で補間する (2026-09-02 neco 指示)。
      deps.log.info(`forum-spawn template selection needs input thread=${thread.id}: ${selection.error}`);
      await askForMissingForumSpawnInfo(deps, thread, { title, body, missing: ["template"] });
      return { ok: false, error: "template selection requested" };
    }
    template = selection.template;
  }
  const provider = template.target_provider;
  if (!provider) {
    deps.log.warn(`forum-spawn selected template missing provider thread=${thread.id} template=${template.call_name}`);
    await reply(deps, thread, `起動テンプレ \`${template.call_name}\` の provider 設定がありません。`);
    return { ok: false, error: "selected template has no provider" };
  }

  let freshTagState = suppliedContent?.tagState;
  if (!freshTagState) {
    try {
      freshTagState = await thread.fetchTagState();
    } catch (error) {
      deps.log.warn(`forum-spawn tag refresh failed thread=${thread.id}: ${(error as Error).message}`);
      await reply(deps, thread, "Forum タグの最新状態を確認できなかったため、セッションを起動しませんでした。");
      return { ok: false, error: "forum tag refresh failed" };
    }
  }
  if (hasConcordiaManagedForumTag(freshTagState)) {
    deps.log.info(`forum-spawn explicit/Cc-managed thread ignored after refresh thread=${thread.id}`);
    return { ok: false, error: "Concordia-managed forum tag" };
  }
  const activeRuntimeRules = activeRuntimeRuleNames(freshTagState);

  // delegation invoke (「実装タスク」ラッパー + 完了駆動 run) ではなく /spawn と同じ
  // 素のセッション起動 + startup inject を使う (2026-09-02 neco 指示: Inject は spawn の
  // ものと同一に)。 delegation 経由だと一問一答で即 session-end してしまい、 Forum
  // スレッドを窓口にした対話セッションにならない。
  const result = await callConcordia<{
    ok: boolean;
    pid?: number | null;
  }>(deps.concordiaUrl, "POST", "/v1/admin/spawn-session", {
    template: template.call_name,
    inject_prompt: false,
    prompt: buildForumSpawnPrompt(title, body, activeRuntimeRules),
    project: project.project,
    subsidiary_id: deps.subsidiaryId ?? null,
    requester_discord_user_id: thread.ownerId,
    source_discord_guild_id: thread.guildId,
    source_discord_channel_id: thread.id,
  });
  if ("error" in result || !result.ok) {
    const error = "error" in result ? result.error : "session spawn failed";
    // API / SDK のエラーには local path、private endpoint、command line が含まれ得る。
    // 詳細は改行を無害化した内部ログに限定し、外部 guild へは安定した文面だけを返す。
    deps.log.warn(
      `forum-spawn failed thread=${thread.id} template=${template.call_name}: ${JSON.stringify(error)}`,
    );
    await reply(deps, thread, "セッション起動に失敗しました。Bot のログを確認してください。");
    return { ok: false, error: "session spawn failed" };
  }
  deps.log.info(
    `forum-spawn requested thread=${thread.id} template=${template.call_name} ` +
    `provider=${provider} project=${project.project} pid=${result.pid ?? "n/a"}`,
  );
  await reply(
    deps,
    thread,
    `Cc がセッションを起動しました（provider: \`${provider}\`${template.model ? `, model: \`${template.model}\`` : ""}）。このスレッドがセッションとの窓口になります。`,
  );
  return { ok: true };
}

/**
 * 不足情報をスレッドで質問する。 質問面が未配線 / 依頼者不明 / 聞き返し上限のときは
 * 何が足りないかを平文で伝えて終わる (無言で捨てない)。
 */
async function askForMissingForumSpawnInfo(
  deps: ForumSpawnDeps,
  thread: ForumSpawnThread,
  content: { title: string; body: string; missing: readonly ForumSpawnMissingField[] },
): Promise<void> {
  const missing = content.missing.length > 0 ? content.missing : (["project"] as const);
  deps.log.info(`forum-spawn info missing thread=${thread.id} fields=${missing.join(",")}`);
  if (deps.requestIntake && thread.ownerId) {
    try {
      const asked = await deps.requestIntake({
        thread,
        requesterUserId: thread.ownerId,
        title: content.title,
        body: content.body,
        missing,
      });
      if (asked) return;
    } catch (error) {
      deps.log.warn(`forum-spawn intake question failed thread=${thread.id}: ${(error as Error).message}`);
      // カード投稿の失敗を無言で終わらせず、webhook の通常返信経路を試す。
    }
  }
  await reply(deps, thread, forumSpawnIntakeGiveUpMessage(missing));
}

export function isConcordiaSessionStarter(content: string): boolean {
  return /^\*\*(?:Session|TaskWorkflow)\*\* `[^`]+`/m.test(content)
    && /\*\*(?:Repo|Repository)\*\*/.test(content);
}

export function buildForumSpawnTrigger(guildId: string, threadId: string): string {
  return `${FORUM_SPAWN_TRIGGER_PREFIX}:${guildId}:${threadId}`;
}

export function parseForumSpawnTrigger(value: string | null | undefined): { guildId: string; threadId: string } | null {
  if (!value) return null;
  const [prefix, guildId, threadId, ...rest] = value.split(":");
  if (prefix !== FORUM_SPAWN_TRIGGER_PREFIX || !guildId || !threadId || rest.length > 0) return null;
  return { guildId, threadId };
}

export function buildForumSpawnPrompt(
  title: string,
  body: string,
  activeRuntimeRules: readonly string[] = [],
): string {
  return [
    "## Discord Session forum request",
    `Title: ${title.trim()}`,
    ...(activeRuntimeRules.length > 0
      ? ["", `Active rules: ${activeRuntimeRules.join(", ")}`]
      : []),
    "",
    body.trim() || "（本文なし）",
  ].join("\n");
}

async function fetchStarterWithRetry(
  thread: Pick<ForumSpawnThread, "fetchStarterMessage">,
  wait: ((ms: number) => Promise<void>) | undefined,
): Promise<{ content: string } | null> {
  const sleep = wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const starter = await thread.fetchStarterMessage();
      if (starter) return starter;
    } catch {
      // ThreadCreate can precede starter message visibility and Discord may answer
      // Unknown Message instead of null. Treat both forms as the same short race.
    }
    if (attempt < 2) await sleep(200 * (attempt + 1));
  }
  return null;
}

function activeRuntimeRuleNames(state: ForumTagState): string[] {
  const selected = new Set(state.appliedTags);
  const allowed = new Set<string>(SESSION_RUNTIME_RULE_TAG_NAMES);
  return state.availableTags
    .filter((tag) => selected.has(tag.id) && allowed.has(tag.name))
    .map((tag) => tag.name);
}

async function reply(deps: ForumSpawnDeps, thread: ForumSpawnThread, content: string): Promise<void> {
  await deps.postToThread(thread.id, content.slice(0, 1900));
}
