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
const MAX_GUARD_ADVISORY_POST_CLAIMS = 5_000;

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

/**
 * 権限の無い投稿者の起動を管理職が承認するときの、確定済みスナップショット。
 * 承認カードは起動に要る情報 (関係プロジェクト / タスク内容 / モデル) が揃ってから出す
 * (2026-09-03 neco 指示) ので、不足情報の回答で補完した本文と選択結果をここに固定する。
 */
export interface ApprovedForumSpawnContent {
  readonly title: string;
  /** 起動に使う本文 (不足情報の回答で補完済みのことがある)。 */
  readonly body: string;
  /** カード作成時のスレッド本文 (starter)。 承認後の改変検知はこれと突き合わせる。 省略時は body。 */
  readonly starterBody?: string;
  readonly tagState: ForumTagState;
  /** 確定した関係プロジェクト (registry 名)。 */
  readonly project?: string;
  /** 確定した起動モデル nickname / effort、または旧テンプレ選択。 */
  readonly model?: string;
  readonly effort?: string;
  readonly template?: string;
}

/**
 * spawn 実行部へ渡す投稿内容の差し替え。 承認経路はタグ状態まで固定するが、
 * 不足情報の回答経路は本文だけを補完し、タグは実行時に取り直す (回答の間に
 * 付け替えられたタグを取りこぼさないため)。
 */
export type ForumSpawnResult =
  | { ok: true }
  | { ok: false; error: string };

export interface GuardAdvisoryPostClaims {
  claim: (threadId: string) => boolean;
  /** 投稿に失敗した claim を解放し、次回の spawn 再入で再試行できるようにする。 */
  release: (threadId: string) => void;
}

/** プロセス生存中、スレッドごとの advisory 投稿を一度だけ確保する。 */
export function createGuardAdvisoryPostClaims(): GuardAdvisoryPostClaims {
  const claimedThreads = new Set<string>();
  const claim = (threadId: string): boolean => {
    if (claimedThreads.has(threadId)) return false;
    // 上限は雑でよい (thread id は小さく、溢れたら注記が最大 1 回増えるだけ)。
    if (claimedThreads.size >= MAX_GUARD_ADVISORY_POST_CLAIMS) claimedThreads.clear();
    claimedThreads.add(threadId);
    return true;
  };
  const release = (threadId: string): void => {
    claimedThreads.delete(threadId);
  };
  return { claim, release };
}

export interface SuppliedForumSpawnContent {
  readonly title: string;
  readonly body: string;
  readonly tagState?: ForumTagState;
  /** 不足情報の回答 (テンプレ選択メニュー) で確定した起動テンプレ。 selector を通さず使う。 */
  readonly template?: string;
  /** 不足情報の回答 (プロジェクト選択メニュー) で確定した関係プロジェクト。 registry 再解決に賭けない。 */
  readonly project?: string;
  /** モデル/Effort 質問カードで確定した起動モデル (nickname: fable / opus / sonnet / sol / terra)。 */
  readonly model?: string;
  /** モデル質問カードで選んだ effort。 未指定は provider 既定 (claude=high / codex=xhigh)。 */
  readonly effort?: string;
  /** カード作成時の starter 本文 (承認スナップショット由来のときだけ)。 */
  readonly starterBody?: string;
  /** 管理職の承認を経た再入 (forum-spawn-approval.ts)。 権限確認を再び行わず、内容も接ぎ足さない。 */
  readonly approved?: boolean;
}

/** Session forum の起動候補モデル (2026-09-02 neco 指示: Test forum の選択と同型)。 */
export const FORUM_MODEL_NICKS = ["fable", "opus", "sonnet", "sol", "terra"] as const;
export type ForumModelNick = (typeof FORUM_MODEL_NICKS)[number];
export const FORUM_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ForumEffort = (typeof FORUM_EFFORTS)[number];

export interface ForumModelChoice {
  nick: ForumModelNick;
  /** 選択メニュー表示名 (例: `Fable (claude-fable-5-1)`)。 */
  label: string;
  provider: string;
  model: string;
  emoji: string | null;
  defaultEffort: ForumEffort;
}

/**
 * 起動候補モデルを Delegation template 群から解決する。 モデル id や絵文字は
 * 素のモデルテンプレ (fable-mid / opus-mid / sol-mid / haiku 等) が正本で、
 * テンプレの model を更新すれば forum 側も追従する。 解決できない nickname は出さない。
 */
export function forumModelChoices(templates: readonly DelegationTemplateLite[]): ForumModelChoice[] {
  const choices: ForumModelChoice[] = [];
  for (const nick of FORUM_MODEL_NICKS) {
    const found = templates
      .filter((candidate) => candidate.is_active && candidate.target_provider && candidate.model?.trim())
      .map((candidate) => {
        const name = candidate.call_name.toLowerCase();
        const rank = name === nick ? 0 : name === `${nick}-mid` ? 1 : name.startsWith(`${nick}-`) ? 2 : -1;
        return { candidate, name, rank };
      })
      .filter((entry) => entry.rank >= 0)
      .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))[0]?.candidate;
    if (!found) continue;
    const provider = found.target_provider!;
    choices.push({
      nick,
      label: `${nick[0]!.toUpperCase()}${nick.slice(1)} (${found.model!.trim()})`,
      provider,
      model: found.model!.trim(),
      emoji: found.emoji?.trim() || null,
      defaultEffort: provider === "claude" ? "high" : "xhigh",
    });
  }
  return choices;
}

/**
 * effort を provider の語彙へ正規化する。 未指定/不正は Test forum と同じ既定
 * (claude=high / codex=xhigh)。 Claude Code に `minimal` は無いので low へ丸める。
 */
export function normalizeForumEffort(provider: string, requested?: string | null): ForumEffort {
  const value = requested?.trim().toLowerCase() as ForumEffort | undefined;
  if (!value || !FORUM_EFFORTS.includes(value)) return provider === "claude" ? "high" : "xhigh";
  if (provider === "claude" && value === "minimal") return "low";
  return value;
}

/**
 * 投稿がモデルを明示しているときだけ確定する (nickname か model id の 1 件一致)。
 * effort も本文に明示があれば拾う (無ければ undefined = provider 既定)。
 */
export function matchExplicitForumModel(
  title: string,
  body: string,
  choices: readonly ForumModelChoice[],
): { choice: ForumModelChoice; effort?: ForumEffort } | null {
  const haystack = `${title}\n${body}`.toLowerCase();
  const matched = choices.filter(
    (choice) => containsAsciiIdentifier(haystack, choice.nick)
      || containsAsciiIdentifier(haystack, choice.model.toLowerCase()),
  );
  if (matched.length !== 1) return null;
  const effort = FORUM_EFFORTS.find(
    (candidate) => new RegExp(`(^|[^a-z])${candidate}([^a-z]|$)`).test(haystack),
  );
  return { choice: matched[0]!, ...(effort ? { effort } : {}) };
}

function containsAsciiIdentifier(haystack: string, value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`).test(haystack);
}

export function matchesApprovedForumContent(
  title: string,
  starterContent: string,
  appliedTags: readonly string[],
  approved: ApprovedForumSpawnContent,
): boolean {
  const approvedTags = approved.tagState.appliedTags;
  return title === approved.title
    && starterContent.trim() === (approved.starterBody ?? approved.body)
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
   * ガード所見の投稿枠をこのスレッド用に確保する (true = 確保成功)。
   * 未配線なら毎回投稿 (従来どおり)。 spawn 再入 (質問回答/承認) のたびに同じ注記を
   * 繰り返さず、並行した再入でも二重投稿しないための claim。
   */
  guardAdvisoryPostClaims?: GuardAdvisoryPostClaims;
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
  /**
   * 起動モデル確定時にスレッド名へモデル絵文字を付けるための rename 口 (best-effort)。
   * 未配線ならリネームしない。 2026-09-02 neco 指示。
   */
  renameThread?: (threadId: string, name: string) => Promise<void>;
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
    if (!deps.requestApproval) {
      await reply(deps, thread, "このユーザーにはセッション起動権限がありません。");
      return;
    }
    // 承認カードは起動に要る情報が揃ってから出す (2026-09-03 neco 指示)。 不足情報の
    // 聞き返しとモデル選択は権限者と同じ経路で進め、確定した内容を executeForumSpawn の
    // 末尾 (spawn 直前) で承認に回す。
  }
  await executeForumSpawn(deps, thread);
}

/**
 * spawn 続行部。 再入口は 2 つ:
 *  - 承認ボタン (forum-spawn-approval.ts): 承認時点の確定内容 (本文 + タグ状態 + 関係
 *    プロジェクト / モデル / effort) を固定して渡す (`approved: true`)。
 *  - 不足情報の回答 (forum-spawn-intake.ts): 補完した本文と選択回答の override を渡し、
 *    タグ状態は取り直す。
 * 権限の無い投稿者の場合は、情報が揃った時点 (spawn 直前) で承認カードを出して止まる。
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
    if (guarded.advisoryText && (deps.guardAdvisoryPostClaims?.claim(thread.id) ?? true)) {
      // ガード所見は advisory: スレッドへ注記して起動は続ける。注記の投稿失敗で
      // spawn を止めない (所見は監査記録にも残っている)。 質問への回答などで
      // ガードが再実行されても、同じスレッドへの注記は 1 回だけ (2026-09-02 neco 指示)。
      try {
        await reply(deps, thread, guarded.advisoryText);
      } catch (error) {
        deps.guardAdvisoryPostClaims?.release(thread.id);
        deps.log.warn(`forum-spawn advisory note post failed thread=${thread.id}: ${(error as Error).message}`);
      }
    }
  }
  // project の解決順:
  //  1. 質問への選択メニュー回答 (override) — registry 再解決に賭けない。子会社の関係
  //     プロジェクトは project code registry に載っていないことがあり、回答を本文追記
  //     だけで再解決すると毎回失敗して質問がループする。
  //  2. project code registry (本文/タイトルから)。
  //  3. 子会社のみ: 関係プロジェクト名そのものを本文/タイトルから照合する。
  const project = (suppliedContent?.project ? asSubsidiaryProjectTarget(suppliedContent.project) : null)
    ?? deps.resolveProjectTarget(title, body)
    ?? matchSubsidiaryProjectInText(title, body, deps.resolveSubsidiaryProjects?.() ?? []);
  // Session forum への投稿は「起動依頼」。 起動に要る情報が欠けていたら平文の拒否で
  // 終わらせず、 同じスレッドで聞き返す (2026-09-01 neco 指示 3)。
  const missing = detectMissingForumSpawnInfo({ body, projectResolved: project !== null });
  if (missing.length > 0 || !project) {
    // 権限の無い投稿者の起動承認は、カード作成時の exact content に対するもの。
    // 承認後に依頼者の回答を追記すると、未承認の作業内容で起動できてしまう。
    // 承認スナップショットが不完全な場合は内容の接ぎ足しを禁止し、完全な
    // 新規スレッドを改めて承認してもらう (情報充足後に承認する運用では通常起きない)。
    if (suppliedContent?.approved) {
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
  const modelChoices = forumModelChoices(templates);
  let template: DelegationTemplateLite | null = null;
  let modelTarget: { nick: ForumModelNick; provider: string; model: string; effort: ForumEffort; emoji: string | null } | null = null;
  if (suppliedContent?.model) {
    // モデル/Effort 質問カードの回答が正 (2026-09-02 neco 指示: Test forum と同型の選択)。
    const choice = modelChoices.find((candidate) => candidate.nick === suppliedContent.model);
    if (!choice) {
      // suppliedContent は interaction 境界から来る。未検証値をログ行や Discord の
      // Markdown へ直接反射せず、診断ログでは JSON 文字列化して改行を無害化する。
      deps.log.warn(
        `forum-spawn supplied model unavailable thread=${thread.id} `
        + `model=${JSON.stringify(suppliedContent.model)}`,
      );
      await reply(deps, thread, "選択されたモデルは利用できません。もう一度選択してください。");
      return { ok: false, error: "supplied model unavailable" };
    }
    modelTarget = {
      nick: choice.nick,
      provider: choice.provider,
      model: choice.model,
      effort: normalizeForumEffort(choice.provider, suppliedContent.effort),
      emoji: choice.emoji,
    };
  } else if (suppliedContent?.template) {
    // 旧テンプレ選択カードの回答互換。
    const chosen = templates.find(
      (candidate) => candidate.call_name === suppliedContent.template
        && candidate.is_active && candidate.forum_tag === true,
    );
    if (!chosen) {
      deps.log.warn(
        `forum-spawn supplied template unavailable thread=${thread.id} `
        + `template=${JSON.stringify(suppliedContent.template)}`,
      );
      await reply(deps, thread, "選択された起動テンプレは利用できません。もう一度選択してください。");
      return { ok: false, error: "supplied template unavailable" };
    }
    template = chosen;
  } else {
    // モデルは投稿に明示があるときだけ自動確定し、無ければ質問で人間に選んでもらう
    // (2026-09-02 neco 指示: モデルも明示的でなければ聞く)。
    // selector (Sonnet の推測) は質問面が未配線な構成のフォールバックに残す。
    const explicitModel = matchExplicitForumModel(title, body, modelChoices);
    const explicitTemplate = explicitModel ? null : matchExplicitForumTemplate(title, body, templates);
    if (explicitModel) {
      modelTarget = {
        nick: explicitModel.choice.nick,
        provider: explicitModel.choice.provider,
        model: explicitModel.choice.model,
        effort: normalizeForumEffort(explicitModel.choice.provider, explicitModel.effort),
        emoji: explicitModel.choice.emoji,
      };
    } else if (explicitTemplate) {
      template = explicitTemplate;
    } else if (deps.requestIntake) {
      deps.log.info(`forum-spawn model not explicit; asking thread=${thread.id}`);
      await askForMissingForumSpawnInfo(deps, thread, { title, body, missing: ["template"] });
      return { ok: false, error: "template selection requested" };
    } else {
      const selection = await deps.selectTemplate({ title, body, templates });
      if (!selection.ok) {
        deps.log.info(`forum-spawn template selection needs input thread=${thread.id}: ${selection.error}`);
        await askForMissingForumSpawnInfo(deps, thread, { title, body, missing: ["template"] });
        return { ok: false, error: "template selection requested" };
      }
      template = selection.template;
    }
  }
  const provider = modelTarget?.provider ?? template?.target_provider ?? null;
  if (!provider) {
    deps.log.warn(`forum-spawn selected template missing provider thread=${thread.id} template=${template?.call_name ?? "-"}`);
    await reply(deps, thread, `起動テンプレ \`${template?.call_name ?? "?"}\` の provider 設定がありません。`);
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

  // 権限の無い投稿者は、ここまでで確定した内容 (関係プロジェクト / モデル / effort / 補完済み
  // 本文 / タグ) をスナップショットにして管理職の承認へ回す (2026-09-03 neco 指示: 承認は
  // 必要な情報を揃えた後)。 承認ボタンからの再入 (`approved`) はこの分岐を通らない。
  if (!suppliedContent?.approved && deps.isLaunchUserAllowed?.(thread.ownerId ?? "") !== true) {
    if (!deps.requestApproval) {
      await reply(deps, thread, "このユーザーにはセッション起動権限がありません。");
      return { ok: false, error: "launch user not allowed" };
    }
    // 承認後の改変検知は starter 本文と突き合わせるので、補完済み本文とは別に固定する。
    const starterBody = suppliedContent?.starterBody
      ?? (await fetchStarterWithRetry(thread, deps.wait))?.content.trim();
    if (starterBody === undefined) {
      await reply(deps, thread, "最初の投稿を取得できなかったため、承認を依頼できませんでした。");
      return { ok: false, error: "starter message unavailable" };
    }
    const approvalContent: ApprovedForumSpawnContent = {
      title,
      body,
      starterBody,
      tagState: freshTagState,
      project: project.project,
      ...(modelTarget
        ? { model: modelTarget.nick, effort: modelTarget.effort }
        : {}),
      ...(template ? { template: template.call_name } : {}),
    };
    deps.log.info(
      `forum-spawn approval requested thread=${thread.id} owner=${thread.ownerId ?? "-"} `
      + `project=${project.project} target=${modelTarget?.model ?? template?.call_name ?? "-"}`,
    );
    await deps.requestApproval(thread, approvalContent);
    return { ok: false, error: "approval requested" };
  }

  // delegation invoke (「実装タスク」ラッパー + 完了駆動 run) ではなく /spawn と同じ
  // 素のセッション起動 + startup inject を使う (2026-09-02 neco 指示: Inject は spawn の
  // ものと同一に)。 delegation 経由だと一問一答で即 session-end してしまい、 Forum
  // スレッドを窓口にした対話セッションにならない。
  const prompt = buildForumSpawnPrompt(title, body, activeRuntimeRules);
  const commonSpawnFields = {
    prompt,
    project: project.project,
    subsidiary_id: deps.subsidiaryId ?? null,
    requester_discord_user_id: thread.ownerId,
    source_discord_guild_id: thread.guildId,
    source_discord_channel_id: thread.id,
  };
  // モデル別絵文字 (🦸 fable / 🧙‍♂️ opus / ☀️ sol …) を優先し、選択元に
  // 無ければ同じモデルの別テンプレ、最後に起動テンプレ自身から補完する。
  // spawn metadata と Forum 表示で同じ値を使い、状態リネーム時の不一致を防ぐ。
  const spawnModel = modelTarget?.model ?? template?.model ?? null;
  const spawnEmoji = modelTarget?.emoji
    ?? modelEmojiFromTemplates(spawnModel, templates)
    ?? template?.emoji?.trim()
    ?? "";
  const result = await callConcordia<{
    ok: boolean;
    pid?: number | null;
  }>(deps.concordiaUrl, "POST", "/v1/admin/spawn-session", modelTarget
    ? {
      // モデル直指定は /spawn の provider 経路と同じ (effort の options 形も同一)。
      provider: modelTarget.provider,
      model: modelTarget.model,
      options: modelTarget.provider === "claude"
        ? { effort: modelTarget.effort }
        : { model_reasoning_effort: modelTarget.effort },
      // モデル絵文字を session の delegation_emoji にする。 これが無いと session channel /
      // スレッドの状態リネームで絵文字が落ちる (2026-09-03 neco 指示)。
      ...(spawnEmoji ? { emoji: spawnEmoji } : {}),
      ...commonSpawnFields,
    }
    : {
      template: template!.call_name,
      inject_prompt: false,
      ...commonSpawnFields,
    });
  const spawnLabel = modelTarget ? modelTarget.model : template!.call_name;
  if ("error" in result || !result.ok) {
    const error = "error" in result ? result.error : "session spawn failed";
    // API / SDK のエラーには local path、private endpoint、command line が含まれ得る。
    // 詳細は改行を無害化した内部ログに限定し、外部 guild へは安定した文面だけを返す。
    deps.log.warn(
      `forum-spawn failed thread=${thread.id} target=${spawnLabel}: ${JSON.stringify(error)}`,
    );
    await reply(deps, thread, "セッション起動に失敗しました。Bot のログを確認してください。");
    return { ok: false, error: "session spawn failed" };
  }
  deps.log.info(
    `forum-spawn requested thread=${thread.id} target=${spawnLabel} ` +
    `provider=${provider} project=${project.project} pid=${result.pid ?? "n/a"}` +
    (modelTarget ? ` effort=${modelTarget.effort}` : ""),
  );
  if (spawnEmoji && deps.renameThread && !thread.name.startsWith(spawnEmoji)) {
    // 起動モデルが決まったらスレッド名にモデル絵文字を前置する (2026-09-02 neco 指示)。
    // リネーム失敗 (権限/レート制限) で起動フローは止めない。
    const renamed = `${spawnEmoji} ${thread.name}`.slice(0, 100);
    try {
      await deps.renameThread(thread.id, renamed);
    } catch (error) {
      deps.log.warn(`forum-spawn thread rename failed thread=${thread.id}: ${(error as Error).message}`);
    }
  }
  await reply(
    deps,
    thread,
    `${spawnEmoji ? `${spawnEmoji} ` : ""}Cc がセッションを起動しました（provider: \`${provider}\``
    + `${spawnModel ? `, model: \`${spawnModel}\`` : ""}`
    + `${modelTarget ? `, effort: \`${modelTarget.effort}\`` : ""}）。このスレッドがセッションとの窓口になります。`,
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

/** 明示照合の対象から外す一般語 (本文に頻出し、テンプレ指定の意図と読めない)。 */
const EXPLICIT_TEMPLATE_STOPWORDS = new Set(["claude", "code", "forum", "gpt", "session"]);

/**
 * モデル別の絵文字を Delegation template 群から引く (2026-09-02 neco 指示:
 * Fable=🦸 / Opus=🧙‍♂️ / Sol=☀️ など)。 モデル id のトークン (fable / opus / sol /
 * sonnet / haiku / luna / terra …) で call_name が始まる素のモデルテンプレ
 * (fable-mid / opus-mid / sol-mid / haiku 等) の emoji を採用する。
 * 優先順: call_name がトークン一致 > `<token>-mid` > その他の先頭一致 (名前順)。
 * 引けなければ null (呼び出し側はテンプレ自身の emoji へフォールバック)。
 */
export function modelEmojiFromTemplates(
  model: string | null | undefined,
  templates: readonly DelegationTemplateLite[],
): string | null {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return null;
  const tokens = normalized.split(/[^a-z0-9.]+/).filter(
    (token) => token.length >= 3 && !/^\d/.test(token) && !EXPLICIT_TEMPLATE_STOPWORDS.has(token),
  );
  const candidates = templates
    .filter((candidate) => candidate.is_active && candidate.emoji?.trim())
    .flatMap((candidate) => {
      const name = candidate.call_name.toLowerCase();
      const token = tokens.find((t) => name === t || name.startsWith(`${t}-`));
      if (!token) return [];
      const rank = name === token ? 0 : name === `${token}-mid` ? 1 : 2;
      return [{ rank, name, emoji: candidate.emoji.trim() }];
    })
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return candidates[0]?.emoji ?? null;
}

/**
 * 投稿タイトル/本文がテンプレ (モデル) を明示しているときだけ、そのテンプレを返す。
 * 照合キーは call_name・model 全文・model のトークン (例: claude-sonnet-5 → sonnet)。
 * 0 件 = 明示なし、2 件以上 = 曖昧 — どちらも null (質問で人間に選んでもらう)。
 */
export function matchExplicitForumTemplate(
  title: string,
  body: string,
  templates: readonly DelegationTemplateLite[],
): DelegationTemplateLite | null {
  const haystack = `${title}\n${body}`.toLowerCase();
  const haystackTokens = new Set(haystack.split(/[^a-z0-9.]+/).filter(Boolean));
  const matched = templates.filter((candidate) => {
    if (!candidate.is_active || candidate.forum_tag !== true) return false;
    const identifiers = new Set([candidate.call_name.toLowerCase()]);
    const modelTokens = new Set<string>();
    const model = candidate.model?.trim().toLowerCase();
    if (model) {
      identifiers.add(model);
      for (const token of model.split(/[^a-z0-9.]+/)) {
        if (token.length >= 3 && !/^\d/.test(token) && !EXPLICIT_TEMPLATE_STOPWORDS.has(token)) {
          modelTokens.add(token);
        }
      }
    }
    const hasIdentifier = [...identifiers]
      .some((identifier) => identifier.length >= 3 && includesIdentifier(haystack, identifier));
    const hasModelToken = [...modelTokens].some((token) => haystackTokens.has(token));
    return hasIdentifier || hasModelToken;
  });
  return matched.length === 1 ? matched[0] ?? null : null;
}

function includesIdentifier(haystack: string, identifier: string): boolean {
  let index = haystack.indexOf(identifier);
  while (index >= 0) {
    const before = haystack[index - 1];
    const after = haystack[index + identifier.length];
    if ((!before || !/[a-z0-9._-]/.test(before)) && (!after || !/[a-z0-9._-]/.test(after))) {
      return true;
    }
    index = haystack.indexOf(identifier, index + 1);
  }
  return false;
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
    "以下はフォーラム投稿者からの作業依頼の正本です。この内容を今回のタスクとして着手し、",
    "不明点が無ければ実装・作業まで進めてください。進捗と結果は投稿元スレッドへ報告されます。",
    "",
    `Title: ${title.trim()}`,
    ...(activeRuntimeRules.length > 0
      ? ["", `Active rules: ${activeRuntimeRules.join(", ")}`]
      : []),
    "",
    body.trim() || "（本文なし）",
  ].join("\n");
}

/**
 * 子会社の関係プロジェクト名を project target の形にする。 spawn は project 名だけを
 * `/v1/admin/spawn-session` へ渡し、 cwd は workspace roots からサーバ側が解決するため
 * code / cwd はここでは持たない。
 */
function asSubsidiaryProjectTarget(name: string): ForumProjectTarget | null {
  const trimmed = name.trim();
  return trimmed ? { project: trimmed, code: trimmed, cwd: "" } : null;
}

/**
 * 関係プロジェクト名そのものをタイトル/本文から照合する (大文字小文字は区別しない)。
 * 子会社の担当プロジェクトは project code registry に載っていないことがあるため、
 * registry 解決の後段としてこちらでも引っ掛ける。 複数一致は最長名を採る。
 */
function matchSubsidiaryProjectInText(
  title: string,
  body: string,
  projects: readonly string[],
): ForumProjectTarget | null {
  const haystack = `${title}\n${body}`;
  const matched = projects
    .map((name) => name.trim())
    .filter((name) => {
      if (!name) return false;
      // Registry resolver と同じ識別子境界に限定する。単純な includes だと、例えば
      // project "AI" が "maintain" に一致して別 repository を暗黙選択してしまう。
      return new RegExp(
        `(^|[^a-z0-9_])${escapeRegExp(name)}([^a-z0-9_]|$)`,
        "i",
      ).test(haystack);
    })
    .sort((a, b) => b.length - a.length)[0];
  return matched ? asSubsidiaryProjectTarget(matched) : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
