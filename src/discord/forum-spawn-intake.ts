/**
 * Session forum の spawn で足りない情報を、スレッド内で本人に聞き返す受付。
 *
 * Session forum への投稿は「セッション起動の依頼」として扱う (2026-09-01 neco 指示 3)。
 * ところが起動に要る情報 — 関係プロジェクトと作業内容 — は投稿に書かれていないことが
 * あり、従来は平文の拒否で終わっていた。依頼者はスレッドを立て直す羽目になり、
 * 「投稿したのに何も起きない」状態が残る。
 *
 * ここでは不足項目を検出したら **同じスレッドで質問を出し**、回答 (選択メニュー /
 * スレッドへの返信) を本文へ足して spawn を再開する。質問の往復はスレッド 1 本につき
 * `MAX_ASK_COUNT` 回までで、それ以上は打ち切る (人間が答えない限り進まないので
 * 自動ループにはならないが、聞き返しが延々続く面も作らない)。
 *
 * @implements spec/feature/subsidiary-delegation.md §3.1
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type Interaction,
} from "discord.js";

const CUSTOM_ID_PREFIX = "forum-spawn-intake:";
const PENDING_TTL_MS = 60 * 60 * 1000;
/** 同一スレッドで聞き返す上限。 これを超えたら新しいスレッドで出し直してもらう。 */
export const MAX_ASK_COUNT = 3;
/** Discord の select menu は 25 件まで。 */
const MAX_PROJECT_CHOICES = 25;

/** spawn に必要だが投稿から取れなかった項目。 template = 起動テンプレ (モデル) を決められない。 */
export type ForumSpawnMissingField = "project" | "task" | "template";

/** テンプレ質問の選択肢。 label には provider / model を添えて選びやすくする。 */
export interface ForumSpawnTemplateChoice {
  callName: string;
  label: string;
  /** Delegation template の絵文字 (モデルの見分け用)。 無ければ選択肢は絵文字なし。 */
  emoji?: string;
}

/** モデル質問カードの選択肢 (Test forum と同型の Fable/Opus/Sonnet/Sol/Terra)。 */
export interface ForumSpawnModelChoice {
  /** nickname (fable / opus / sonnet / sol / terra)。 回答 override として spawn 側へ渡す。 */
  nick: string;
  label: string;
  emoji?: string;
  /** モデル未選択時は使わない。 選択済みで effort 未選択のときの既定。 */
  defaultEffort: string;
}

/** Effort の選択肢 (Test forum と同じ語彙。 minimal は codex 系のみ有効で claude は low 扱い)。 */
export const FORUM_INTAKE_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export interface PendingForumSpawnIntake {
  guildId: string;
  threadId: string;
  /** スレッド作成者 = 依頼者。 回答者の既定。 */
  requesterUserId: string;
  title: string;
  /** 質問時点の本文。 回答はここへ足していく。 */
  body: string;
  missing: readonly ForumSpawnMissingField[];
  /** このスレッドで質問した回数 (打ち切り判定用)。 回答して再開しても持ち越す。 */
  askCount: number;
  /**
   * `waiting` = 回答待ち。 `answered` = 回答済みで再開に回した。
   * 回答済みの行を消さずに残すのは、 聞き返し回数を持ち越して打ち切りを効かせるため。
   * 回答として取り込むのは `waiting` の間だけなので、 起動後の投稿は飲み込まない。
   */
  status: "waiting" | "answered";
  createdAt: number;
  /** モデル質問カードの候補 (カード再描画に使う)。 */
  modelChoices?: readonly ForumSpawnModelChoice[];
  /** モデル質問カードで選択中のモデル nickname。 起動ボタンで確定する。 */
  chosenModel?: string;
  /** モデル質問カードで選択中の effort。 未選択はモデルの既定。 */
  chosenEffort?: string;
}

/** thread id をキーにした保留質問。 1 スレッドにつき 1 件しか持たない。 */
export type ForumSpawnIntakeStore = Map<string, PendingForumSpawnIntake>;

/**
 * 投稿から取れなかった項目を返す。 純関数 — project の解決可否は呼び出し側が渡す
 * (resolver は Cc の registry を読むため、ここでは判定結果だけを受け取る)。
 */
export function detectMissingForumSpawnInfo(input: {
  body: string;
  projectResolved: boolean;
}): ForumSpawnMissingField[] {
  const missing: ForumSpawnMissingField[] = [];
  if (!input.projectResolved) missing.push("project");
  if (!input.body.trim()) missing.push("task");
  return missing;
}

export type ForumSpawnIntakeComponentRow = ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>;

/**
 * モデル/Effort 質問カード (Test forum の provider・effort 選択と同型、2026-09-02 neco 指示)。
 * select は選択を保存するだけで、「起動」ボタンで確定する。
 */
export function buildForumSpawnModelQuestion(input: {
  requesterUserId: string;
  threadId: string;
  modelChoices: readonly ForumSpawnModelChoice[];
  chosenModel?: string;
  chosenEffort?: string;
}): { content: string; components: ForumSpawnIntakeComponentRow[] } {
  const chosen = input.modelChoices.find((choice) => choice.nick === input.chosenModel);
  const effectiveEffort = input.chosenEffort ?? chosen?.defaultEffort;
  const content = [
    `<@${input.requesterUserId}> 起動するモデルと Effort を選んで「起動」を押してください。`,
    "",
    chosen
      ? `選択中: ${chosen.emoji ? `${chosen.emoji} ` : ""}**${chosen.label}** / effort: **${effectiveEffort}**`
      : "選択中: (モデル未選択)",
  ].join("\n");
  const modelRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}model:${input.threadId}`)
      .setPlaceholder("モデルを選ぶ")
      .addOptions(input.modelChoices.slice(0, MAX_PROJECT_CHOICES).map((choice) => ({
        label: choice.label.slice(0, 100),
        value: choice.nick.slice(0, 100),
        default: choice.nick === input.chosenModel,
        ...(choice.emoji?.trim() ? { emoji: { name: choice.emoji.trim() } } : {}),
      }))),
  );
  const effortRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}effort:${input.threadId}`)
      .setPlaceholder(`Effort を選ぶ (未選択は claude=high / codex=xhigh)`)
      .addOptions(FORUM_INTAKE_EFFORTS.map((effort) => ({
        label: effort,
        value: effort,
        default: effort === input.chosenEffort,
        ...(effort === "minimal" ? { description: "codex 系のみ (Claude は low 扱い)" } : {}),
      }))),
  );
  const launchRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}launch:${input.threadId}`)
      .setLabel("起動")
      .setStyle(ButtonStyle.Success),
  );
  return { content, components: [modelRow, effortRow, launchRow] };
}

/** 質問カードの文面と操作面。 選択肢が無ければ本文だけ (自由記述で答えてもらう)。 */
export function buildForumSpawnIntakeQuestion(input: {
  requesterUserId: string;
  missing: readonly ForumSpawnMissingField[];
  projectChoices: readonly string[];
  templateChoices?: readonly ForumSpawnTemplateChoice[];
  modelChoices?: readonly ForumSpawnModelChoice[];
  chosenModel?: string;
  chosenEffort?: string;
  threadId: string;
}): { content: string; components: ForumSpawnIntakeComponentRow[] } {
  // モデルだけが不足 (project/task は揃っている) なら Test forum 同型のモデル/Effort カード。
  if (
    input.missing.length === 1 && input.missing[0] === "template"
    && (input.modelChoices?.length ?? 0) > 0
  ) {
    return buildForumSpawnModelQuestion({
      requesterUserId: input.requesterUserId,
      threadId: input.threadId,
      modelChoices: input.modelChoices!,
      chosenModel: input.chosenModel,
      chosenEffort: input.chosenEffort,
    });
  }
  const asks: string[] = [];
  if (input.missing.includes("project")) {
    asks.push("- **関係プロジェクト**: どのリポジトリ / プロジェクトの作業ですか (プロジェクトコードでも可)");
  }
  if (input.missing.includes("task")) {
    asks.push("- **タスク内容**: 何をしてほしいかを 1〜数行で");
  }
  if (input.missing.includes("template")) {
    asks.push("- **起動テンプレ (モデル)**: どのテンプレ / モデルでセッションを起動しますか");
  }
  const choices = input.projectChoices.slice(0, MAX_PROJECT_CHOICES);
  const truncated = input.projectChoices.length > choices.length;
  const templateChoices = (input.templateChoices ?? []).slice(0, MAX_PROJECT_CHOICES);
  const hasSelect = (input.missing.includes("project") && choices.length > 0)
    || (input.missing.includes("template") && templateChoices.length > 0);
  const content = [
    `<@${input.requesterUserId}> セッションを起動するのに情報が足りません。`,
    "",
    ...asks,
    "",
    hasSelect
      ? "下の一覧から選ぶか、このスレッドへ返信してください。"
      : "このスレッドへ返信してください。",
    ...(truncated ? ["(一覧は先頭 25 件のみ。 該当が無ければ返信で指定してください)"] : []),
  ].join("\n");
  const components: ForumSpawnIntakeComponentRow[] = [];
  if (input.missing.includes("project") && choices.length > 0) {
    components.push(projectSelectRow(input.threadId, choices));
  }
  if (input.missing.includes("template") && templateChoices.length > 0) {
    components.push(templateSelectRow(input.threadId, templateChoices));
  }
  return { content, components };
}

/** 回答を本文へ足す。 元の本文を消さずに追記し、再解決に掛ける。 */
export function supplementForumSpawnBody(body: string, additions: readonly string[]): string {
  const parts = [body.trim(), ...additions.map((a) => a.trim()).filter(Boolean)].filter(Boolean);
  return parts.join("\n\n");
}

export interface ForumSpawnIntakeRequestDeps {
  store: ForumSpawnIntakeStore;
  /** スレッドへ質問カードを投稿する (webhook はコンポーネント不可なので bot client 経由)。 */
  postCard: (
    threadId: string,
    content: string,
    components: ForumSpawnIntakeComponentRow[],
  ) => Promise<void>;
  log: { info: (message: string) => void; warn: (message: string) => void };
  now?: () => number;
}

export interface ForumSpawnIntakeRequest {
  guildId: string;
  threadId: string;
  requesterUserId: string;
  title: string;
  body: string;
  missing: readonly ForumSpawnMissingField[];
  /** 選択メニューに出す候補 (子会社なら関係プロジェクト)。 空なら自由記述のみ。 */
  projectChoices: readonly string[];
  /** template 質問時の候補 (active + forum_tag の delegation template)。 */
  templateChoices?: readonly ForumSpawnTemplateChoice[];
  /** モデル質問時の候補 (Fable/Opus/Sonnet/Sol/Terra、delegation template から解決)。 */
  modelChoices?: readonly ForumSpawnModelChoice[];
}

/**
 * 不足項目をスレッドで質問し、回答待ちとして積む。
 * 打ち切り上限に達していたら質問せず false を返す (呼び出し側が終了文面を出す)。
 */
export async function requestForumSpawnIntake(
  deps: ForumSpawnIntakeRequestDeps,
  request: ForumSpawnIntakeRequest,
): Promise<boolean> {
  const now = deps.now?.() ?? Date.now();
  pruneForumSpawnIntakes(deps.store, now);
  const previous = deps.store.get(request.threadId);
  const askCount = (previous?.askCount ?? 0) + 1;
  if (askCount > MAX_ASK_COUNT) {
    deps.log.warn(`forum-spawn intake give up thread=${request.threadId} asks=${previous?.askCount ?? 0}`);
    return false;
  }

  const question = buildForumSpawnIntakeQuestion({
    requesterUserId: request.requesterUserId,
    missing: request.missing,
    projectChoices: request.projectChoices,
    templateChoices: request.templateChoices,
    modelChoices: request.modelChoices,
    threadId: request.threadId,
  });
  deps.store.set(request.threadId, {
    guildId: request.guildId,
    threadId: request.threadId,
    requesterUserId: request.requesterUserId,
    title: request.title,
    body: request.body,
    missing: [...request.missing],
    askCount,
    status: "waiting",
    createdAt: now,
    ...(request.modelChoices?.length ? { modelChoices: [...request.modelChoices] } : {}),
  });
  try {
    await deps.postCard(request.threadId, question.content, question.components);
  } catch (error) {
    // 質問を出せなかったら新しい waiting は残さない。ただし、前回までの
    // askCount を失うと投稿失敗を挟んで上限を迂回できるため、既存状態は復元する。
    if (previous) deps.store.set(request.threadId, previous);
    else deps.store.delete(request.threadId);
    throw error;
  }
  deps.log.info(
    `forum-spawn intake asked thread=${request.threadId} missing=${request.missing.join(",")} ask=${askCount}`,
  );
  return true;
}

export interface ForumSpawnIntakeResumeDeps {
  store: ForumSpawnIntakeStore | undefined;
  /**
   * 回答者として認めるか。 依頼者本人は常に可。 それ以外は spawn 権限
   * (社員名簿 `session_spawn`) を要求する — 回答は起動の引き金になるため。
   */
  isLaunchUserAllowed?: (userId: string) => boolean;
  /** 補完済みの内容で再入する。override (template/project/model/effort) は選択面で確定した場合のみ。 */
  resumeSpawn: (
    threadId: string,
    content: {
      title: string;
      body: string;
      template?: string;
      project?: string;
      model?: string;
      effort?: string;
    },
  ) => Promise<void>;
  /** スレッドへの通常返信 (webhook 可)。 */
  reply: (threadId: string, content: string) => Promise<void>;
  log: { info: (message: string) => void; warn: (message: string) => void };
  now?: () => number;
}

export interface ForumSpawnIntakeReply {
  guildId: string;
  channelId: string;
  /** forum スレッドの starter message は id が thread id と同じ。 回答と区別するために使う。 */
  messageId: string;
  authorId: string;
  text: string;
}

/**
 * スレッドへの返信を回答として取り込む。 対象外なら false を返し、 ingress の通常経路へ返す。
 */
export async function handleForumSpawnIntakeReply(
  deps: ForumSpawnIntakeResumeDeps,
  reply: ForumSpawnIntakeReply,
): Promise<boolean> {
  const now = deps.now?.() ?? Date.now();
  const store = deps.store;
  if (!store) return false;
  pruneForumSpawnIntakes(store, now);
  const pending = store.get(reply.channelId);
  if (!pending || pending.status !== "waiting" || pending.guildId !== reply.guildId) return false;
  // forum の starter message (= スレッド本文) は message id が thread id と同じ。
  // 質問より前に存在するものなので回答として取り込まない。
  if (reply.messageId === reply.channelId) return false;
  const text = reply.text.trim();
  if (!text) return false;
  if (!isAnswerAllowed(deps, pending, reply.authorId)) {
    deps.log.info(`forum-spawn intake answer ignored unauthorized user=${reply.authorId} thread=${reply.channelId}`);
    return false;
  }

  await resume(deps, pending, [text]);
  return true;
}

/**
 * この interaction が不足情報の回答面か。 customId だけで判定する — 種別 (select menu) の
 * 確認は dispatch 側で行う。 面の判定を discord.js の型述語に頼ると、 interaction の
 * 部分実装 (テスト double や将来の別コンポーネント) で TypeError になるため。
 */
export function isForumSpawnIntakeInteraction(interaction: Interaction): boolean {
  if (!("customId" in interaction) || typeof interaction.customId !== "string") return false;
  return interaction.customId.startsWith(CUSTOM_ID_PREFIX);
}

export async function dispatchForumSpawnIntakeInteraction(
  interaction: Interaction,
  deps: ForumSpawnIntakeResumeDeps,
): Promise<void> {
  // 種別は discord.js の型述語ではなく形で見る — interaction の部分実装でも落ちないように。
  const values = (interaction as { values?: unknown }).values;
  const isSelect = Array.isArray(values);
  if (!isSelect && !("customId" in interaction)) return;
  // 形ベース判定に伴い discord.js の narrowing が効かないため、必要な面だけを持つ
  // 部分型として扱う (実 interaction / テスト double の両方が満たす)。
  const ix = interaction as unknown as {
    guildId: string | null;
    channelId: string | null;
    user: { id: string };
    reply: (options: { content: string; ephemeral: boolean }) => Promise<unknown>;
    update: (options: {
      content: string;
      components: ForumSpawnIntakeComponentRow[];
      allowedMentions?: { parse: string[] };
    }) => Promise<unknown>;
  };
  const parsed = parseCustomId((interaction as { customId: string }).customId);
  if (!parsed) return;
  const { kind, threadId } = parsed;
  // launch はボタン (values 無し)、それ以外は select (values あり) のみ処理する。
  if (kind === "launch" ? isSelect : !isSelect) return;
  const now = deps.now?.() ?? Date.now();
  const store = deps.store;
  const pending = store?.get(threadId);
  if (!store || !pending || pending.status !== "waiting" || now - pending.createdAt > PENDING_TTL_MS) {
    store?.delete(threadId);
    await ix.reply({ content: "この質問は失効しています。新しいスレッドで依頼し直してください。", ephemeral: true });
    return;
  }
  if (ix.guildId !== pending.guildId || ix.channelId !== pending.threadId) {
    await ix.reply({ content: "この質問は別のスレッドのものです。", ephemeral: true });
    return;
  }
  if (!isAnswerAllowed(deps, pending, ix.user.id)) {
    await ix.reply({
      content: "この質問に答えられるのは依頼者本人か、セッション起動権限のある社員のみです。",
      ephemeral: true,
    });
    return;
  }
  // ── モデル/Effort カード (Test forum 同型): select は選択の保存、起動ボタンで確定 ──
  if (kind === "launch") {
    const chosen = (pending.modelChoices ?? []).find((choice) => choice.nick === pending.chosenModel);
    if (!chosen) {
      await ix.reply({ content: "モデルを選んでから「起動」を押してください。", ephemeral: true });
      return;
    }
    // update の待機中に同じボタンが二重押下されても spawn が 2 回走らないよう、
    // 外部 I/O より先に同期的に回答済みへ遷移させる。update 失敗時だけ再試行可能に戻す。
    const claimed = { ...pending, status: "answered" as const };
    store.set(threadId, claimed);
    try {
      await ix.update({
        content: `起動モデル: ${chosen.emoji ? `${chosen.emoji} ` : ""}**${chosen.label}**`
        + `${pending.chosenEffort ? ` / effort: **${pending.chosenEffort}**` : ""} (回答: <@${ix.user.id}>)`,
        components: [],
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      const current = store.get(threadId);
      if (!current || current === claimed) store.set(threadId, pending);
      throw error;
    }
    await resume(deps, pending, [], {
      model: chosen.nick,
      ...(pending.chosenEffort ? { effort: pending.chosenEffort } : {}),
    });
    return;
  }

  const selected = isSelect ? (values as string[])[0]?.trim() : undefined;
  if (!selected) {
    await ix.reply({ content: "選択肢が選ばれていません。", ephemeral: true });
    return;
  }

  if (kind === "model" || kind === "effort") {
    const isAllowed = kind === "model"
      ? (pending.modelChoices ?? []).some((choice) => choice.nick === selected)
      : FORUM_INTAKE_EFFORTS.includes(selected as (typeof FORUM_INTAKE_EFFORTS)[number]);
    if (!isAllowed) {
      await ix.reply({ content: "選択値が無効です。質問カードから選び直してください。", ephemeral: true });
      return;
    }
    const updated = {
      ...pending,
      ...(kind === "model" ? { chosenModel: selected } : { chosenEffort: selected }),
    };
    store.set(threadId, updated);
    const card = buildForumSpawnModelQuestion({
      requesterUserId: updated.requesterUserId,
      threadId,
      modelChoices: updated.modelChoices ?? [],
      chosenModel: updated.chosenModel,
      chosenEffort: updated.chosenEffort,
    });
    await ix.update({
      content: card.content,
      components: card.components,
      allowedMentions: { parse: [] },
    });
    return;
  }

  if (kind === "template") {
    // テンプレは本文へ足さず override として渡す — selector の再判定に賭けず確定させる。
    await ix.update({
      content: `起動テンプレ: **${selected}** (回答: <@${ix.user.id}>)`,
      components: [],
      allowedMentions: { parse: [] },
    });
    await resume(deps, pending, [], { template: selected });
    return;
  }

  await ix.update({
    content: `関係プロジェクト: **${selected}** (回答: <@${ix.user.id}>)`,
    components: [],
    allowedMentions: { parse: [] },
  });
  // 選んだ project は override として確定させる。 子会社の関係プロジェクトは project code
  // registry に載っていないことがあり、本文追記だけだと再解決に失敗して質問がループする。
  // 本文にも残すのは、起動セッションへ注入される初回指示に対象を明記するため。
  await resume(deps, pending, [`関係プロジェクト: ${selected}`], { project: selected });
}

export function pruneForumSpawnIntakes(store: ForumSpawnIntakeStore, now = Date.now()): void {
  for (const [threadId, pending] of store) {
    if (now - pending.createdAt > PENDING_TTL_MS) store.delete(threadId);
  }
}

/** 打ち切り時にスレッドへ返す文面 (質問を出せなかったときの明示。 無言で捨てない)。 */
export function forumSpawnIntakeGiveUpMessage(missing: readonly ForumSpawnMissingField[]): string {
  const labels = missing.map(
    (m) => (m === "project" ? "関係プロジェクト" : m === "template" ? "起動テンプレ (モデル)" : "タスク内容"),
  );
  return `${labels.join(" と ")}を特定できないため、このスレッドでは起動しません。`
    + "情報を本文に書いた新しいスレッドで依頼してください。";
}

async function resume(
  deps: ForumSpawnIntakeResumeDeps,
  pending: PendingForumSpawnIntake,
  additions: readonly string[],
  overrides: { template?: string; project?: string; model?: string; effort?: string } = {},
): Promise<void> {
  const body = supplementForumSpawnBody(pending.body, additions);
  // 回答済みに倒してから再開する。 消さないのは聞き返し回数を持ち越すため、
  // 待ち状態を降ろすのは起動後の投稿を回答として飲み込まないため。
  deps.store?.set(pending.threadId, { ...pending, body, status: "answered" });
  deps.log.info(`forum-spawn intake answered thread=${pending.threadId} ask=${pending.askCount}`);
  try {
    await deps.resumeSpawn(pending.threadId, {
      title: pending.title,
      body,
      ...(overrides.template ? { template: overrides.template } : {}),
      ...(overrides.project ? { project: overrides.project } : {}),
      ...(overrides.model ? { model: overrides.model } : {}),
      ...(overrides.effort ? { effort: overrides.effort } : {}),
    });
  } catch (error) {
    deps.log.warn(`forum-spawn intake resume failed thread=${pending.threadId}: ${(error as Error).message}`);
    // 例外には local path / endpoint / SDK の応答が含まれ得る。詳細は内部ログに限定し、
    // 外部 guild にも出る Discord 面では安定した文面だけを返す。
    await deps.reply(pending.threadId, "セッション起動の再開に失敗しました。Bot のログを確認してください。")
      .catch(() => { /* スレッドが消えている場合など; best-effort */ });
  }
}

function isAnswerAllowed(
  deps: ForumSpawnIntakeResumeDeps,
  pending: PendingForumSpawnIntake,
  userId: string,
): boolean {
  if (userId === pending.requesterUserId) return true;
  return deps.isLaunchUserAllowed?.(userId) === true;
}

type ForumSpawnIntakeKind = "project" | "template" | "model" | "effort" | "launch";

function parseCustomId(customId: string): { kind: ForumSpawnIntakeKind; threadId: string } | null {
  const match = /^forum-spawn-intake:(project|template|model|effort|launch):([^:]+)$/.exec(customId);
  return match ? { kind: match[1] as ForumSpawnIntakeKind, threadId: match[2]! } : null;
}

function projectSelectRow(
  threadId: string,
  choices: readonly string[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}project:${threadId}`)
      .setPlaceholder("関係プロジェクトを選ぶ")
      .addOptions(choices.map((project) => ({ label: project.slice(0, 100), value: project.slice(0, 100) }))),
  );
}

function templateSelectRow(
  threadId: string,
  choices: readonly ForumSpawnTemplateChoice[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}template:${threadId}`)
      .setPlaceholder("起動テンプレ (モデル) を選ぶ")
      .addOptions(choices.map((choice) => ({
        label: choice.label.slice(0, 100),
        value: choice.callName.slice(0, 100),
        // Delegation template の絵文字でモデルを見分ける (2026-09-02 neco 指示)。
        ...(choice.emoji?.trim() ? { emoji: { name: choice.emoji.trim() } } : {}),
      }))),
  );
}
