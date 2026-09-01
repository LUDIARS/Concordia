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
  StringSelectMenuBuilder,
  type Interaction,
} from "discord.js";

const CUSTOM_ID_PREFIX = "forum-spawn-intake:";
const PENDING_TTL_MS = 60 * 60 * 1000;
/** 同一スレッドで聞き返す上限。 これを超えたら新しいスレッドで出し直してもらう。 */
export const MAX_ASK_COUNT = 3;
/** Discord の select menu は 25 件まで。 */
const MAX_PROJECT_CHOICES = 25;

/** spawn に必要だが投稿から取れなかった項目。 */
export type ForumSpawnMissingField = "project" | "task";

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

/** 質問カードの文面と操作面。 選択肢が無ければ本文だけ (自由記述で答えてもらう)。 */
export function buildForumSpawnIntakeQuestion(input: {
  requesterUserId: string;
  missing: readonly ForumSpawnMissingField[];
  projectChoices: readonly string[];
  threadId: string;
}): { content: string; components: ActionRowBuilder<StringSelectMenuBuilder>[] } {
  const asks: string[] = [];
  if (input.missing.includes("project")) {
    asks.push("- **関係プロジェクト**: どのリポジトリ / プロジェクトの作業ですか (プロジェクトコードでも可)");
  }
  if (input.missing.includes("task")) {
    asks.push("- **タスク内容**: 何をしてほしいかを 1〜数行で");
  }
  const choices = input.projectChoices.slice(0, MAX_PROJECT_CHOICES);
  const truncated = input.projectChoices.length > choices.length;
  const content = [
    `<@${input.requesterUserId}> セッションを起動するのに情報が足りません。`,
    "",
    ...asks,
    "",
    input.missing.includes("project") && choices.length > 0
      ? "下の一覧から選ぶか、このスレッドへ返信してください。"
      : "このスレッドへ返信してください。",
    ...(truncated ? ["(一覧は先頭 25 件のみ。 該当が無ければ返信で指定してください)"] : []),
  ].join("\n");
  const components = input.missing.includes("project") && choices.length > 0
    ? [projectSelectRow(input.threadId, choices)]
    : [];
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
    components: ActionRowBuilder<StringSelectMenuBuilder>[],
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
  /** 補完済みの内容で spawn 実行部へ再入する。 */
  resumeSpawn: (threadId: string, content: { title: string; body: string }) => Promise<void>;
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
  if (!interaction.isStringSelectMenu()) return;
  const threadId = parseCustomId(interaction.customId);
  if (!threadId) return;
  const now = deps.now?.() ?? Date.now();
  const store = deps.store;
  const pending = store?.get(threadId);
  if (!store || !pending || pending.status !== "waiting" || now - pending.createdAt > PENDING_TTL_MS) {
    store?.delete(threadId);
    await interaction.reply({ content: "この質問は失効しています。新しいスレッドで依頼し直してください。", ephemeral: true });
    return;
  }
  if (interaction.guildId !== pending.guildId || interaction.channelId !== pending.threadId) {
    await interaction.reply({ content: "この質問は別のスレッドのものです。", ephemeral: true });
    return;
  }
  if (!isAnswerAllowed(deps, pending, interaction.user.id)) {
    await interaction.reply({
      content: "この質問に答えられるのは依頼者本人か、セッション起動権限のある社員のみです。",
      ephemeral: true,
    });
    return;
  }
  const project = interaction.values[0]?.trim();
  if (!project) {
    await interaction.reply({ content: "プロジェクトが選択されていません。", ephemeral: true });
    return;
  }

  await interaction.update({
    content: `関係プロジェクト: **${project}** (回答: <@${interaction.user.id}>)`,
    components: [],
    allowedMentions: { parse: [] },
  });
  await resume(deps, pending, [`関係プロジェクト: ${project}`]);
}

export function pruneForumSpawnIntakes(store: ForumSpawnIntakeStore, now = Date.now()): void {
  for (const [threadId, pending] of store) {
    if (now - pending.createdAt > PENDING_TTL_MS) store.delete(threadId);
  }
}

/** 打ち切り時にスレッドへ返す文面 (質問を出せなかったときの明示。 無言で捨てない)。 */
export function forumSpawnIntakeGiveUpMessage(missing: readonly ForumSpawnMissingField[]): string {
  const labels = missing.map((m) => (m === "project" ? "関係プロジェクト" : "タスク内容"));
  return `${labels.join(" と ")}を特定できないため、このスレッドでは起動しません。`
    + "情報を本文に書いた新しいスレッドで依頼してください。";
}

async function resume(
  deps: ForumSpawnIntakeResumeDeps,
  pending: PendingForumSpawnIntake,
  additions: readonly string[],
): Promise<void> {
  const body = supplementForumSpawnBody(pending.body, additions);
  // 回答済みに倒してから再開する。 消さないのは聞き返し回数を持ち越すため、
  // 待ち状態を降ろすのは起動後の投稿を回答として飲み込まないため。
  deps.store?.set(pending.threadId, { ...pending, body, status: "answered" });
  deps.log.info(`forum-spawn intake answered thread=${pending.threadId} ask=${pending.askCount}`);
  try {
    await deps.resumeSpawn(pending.threadId, { title: pending.title, body });
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

function parseCustomId(customId: string): string | null {
  const match = /^forum-spawn-intake:project:([^:]+)$/.exec(customId);
  return match ? match[1]! : null;
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
