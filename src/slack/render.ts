// Slack 投稿ペイロードの組み立て + interaction 解析（純粋関数）。
// 副作用 (Web API 呼び出し) は bot.ts 側。ここはテスト可能なロジックだけ。

import { extractRelayableTextFrame } from "../platform/transcript-relay.js";
import { formatOptionCode, labelWithOptionCode } from "../shared/option-code.js";

/** Slack section text の実用上限に合わせた truncate（block text は 3000 字制限）。 */
const MAX_TEXT = 2900;

export function truncateForSlack(text: string, max = MAX_TEXT): string {
  const t = text ?? "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// ─── ライブセッションカード（session channel header の本文を状態で書き換える）─
// 親メッセージ自体を「使用 AI / 現在の作業内容 / 状態」の生きたカードにする。
// active 中は current_task の更新ごとに、終了時は独白ポエム + ✅Done に差し替える。
// spec/feature/slack-platform.md §ライブセッションカード。

export interface SessionCardState {
  /** 表示名（role を解決済みの文字列）。 */
  who: string;
  /**
   * 見出しの先頭アイコン。delegation テンプレで設定した絵文字を spawn 時に
   * セッション metadata へ焼いたもの（無ければ既定の ▶ を使う）。
   */
  emoji?: string | null;
  /** セッションが使う AI provider（claude-code / codex-cli 等）。 */
  provider?: string | null;
  /** metadata 由来の model 名（あれば併記）。 */
  model?: string | null;
  /** runtime metadata または delegation 実行記録由来の reasoning effort。 */
  effortLevel?: string | null;
  /** 現在の作業内容（current_task）。空なら短縮 id を見出しに使う。 */
  currentTask?: string | null;
  /** セッション短縮 id（8 桁）。 */
  shortId: string;
  /** 'active' = 作業中カード / 'ended' = 終了カード。 */
  status: "active" | "ended";
  /** ended 時の独白ポエム（無ければ既定文）。 */
  poem?: string | null;
}

function formatRuntimeValue(value?: string | null): string {
  // Model and effort originate in runtime metadata. Keep them inside the
  // surrounding inline-code delimiter so they cannot alter Slack formatting.
  // A metadata value must also stay on its field's single line.
  return (value?.trim() || "-")
    .replace(/`/g, "ˋ")
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ");
}

/** `renderSessionCard` の戻り値。text はフォールバック / 通知文、blocks が Slack Block Kit 本体。 */
export interface SessionCardPayload {
  text: string;
  blocks: unknown[];
}

/**
 * session channel の header メッセージを組む（純粋）。Block Kit の section/fields で整形する。
 *  - active: Engine / Model / Effort / Session の runtime fields + 📌 作業内容 + 返信ヒント
 *  - ended : ✅ Done 行 + runtime + 独白ポエム（divider で区切る）
 * `text` は通知文字列 / blocks 非対応時のフォールバック。
 */
export function renderSessionCard(state: SessionCardState): SessionCardPayload {
  const engine = formatRuntimeValue(state.provider);
  const model = formatRuntimeValue(state.model);
  const effort = formatRuntimeValue(state.effortLevel);
  const runtime = `*Engine* \`${truncateForSlack(engine, 200)}\` · *Model* \`${truncateForSlack(model, 200)}\` · *Effort* \`${truncateForSlack(effort, 200)}\``;
  if (state.status === "ended") {
    const poem = (state.poem ?? "").trim() || "（記録は残った。次のセッションへ。）";
    const poemText = truncateForSlack(poem, 1500);
    return {
      text: `✅ *Done* — *${state.who}*  \`${state.shortId}\`\n${runtime}\n\n${poemText}`,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `✅ *Done* — *${state.who}*  \`${state.shortId}\`\n${runtime}` },
        },
        { type: "divider" },
        {
          type: "section",
          text: { type: "mrkdwn", text: truncateForSlack(poemText, 2900) },
        },
      ],
    };
  }
  const task = (state.currentTask ?? "").trim();
  const headline = task ? truncateForSlack(task, 200) : state.shortId;
  // ペルソナ名・絵文字は buildSessionBotUsername() 経由で Slack の username フィールドへ。
  // body は runtime fields + 📌 作業内容 + 返信ヒント。
  return {
    text: `${runtime}\n📌 ${headline}\n_(このチャンネルへ投稿すると ${state.who} に送信されます)_`,
    blocks: [
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Engine*\n\`${truncateForSlack(engine, 200)}\`` },
          { type: "mrkdwn", text: `*Model*\n\`${truncateForSlack(model, 200)}\`` },
          { type: "mrkdwn", text: `*Effort*\n\`${truncateForSlack(effort, 200)}\`` },
          { type: "mrkdwn", text: `*Session*\n\`${state.shortId}\`` },
        ],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `📌 *${truncateForSlack(headline, 200)}*` },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `_(このチャンネルへ投稿すると ${state.who} に送信されます)_`,
          },
        ],
      },
    ],
  };
}

/**
 * session channel への最初の投稿本文から、カードの 📌（やる事）に使う短いタイトルを
 * 直接生成する（LLM 非使用・純粋）。先頭の非空行を採り、Markdown 装飾 / 箇条書き
 * 記号を削いで 1 行・最大 max 字に整える。実体が無ければ null（タイトル不設定）。
 */
export function deriveTitleFromPost(text: string, max = 60): string | null {
  const firstLine = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  const cleaned = firstLine
    .replace(/^[#>\-*•\d.)\s]+/, "") // 見出し / 箇条書き / 番号付きの先頭記号を除去
    .replace(/[*_`~]/g, "")          // Markdown 強調記号を除去
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/**
 * report の summary_md から「独白」（冒頭 poem 部分）を抽出する。
 * 3 セクション構造（poem / "---" / 業務報告 / "---" / サマリ）前提で、最初の
 * "---" より前を返す。失敗したら null。control/end-session-flow.ts の同名 helper と
 * 同じ意味論（循環 import を避けるため slack 側に純粋関数として持つ）。
 */
export function extractMonologue(summaryMd: string | null | undefined): string | null {
  if (!summaryMd) return null;
  const sep = summaryMd.indexOf("\n---");
  if (sep <= 0) return null;
  const head = summaryMd.slice(0, sep).trim();
  if (head.length < 10 || head.length > 1500) return null;
  return head;
}

// ─── reaction_added 受信用の絵文字正規化 ─────────────────────────────────
// Slack は reaction を unicode ではなく **絵文字名**（`+1` / `thumbsup` /
// `white_check_mark` 等、コロン無し、skin-tone は `::skin-tone-2` 接尾）で渡す。
// platform/reaction-workflow.ts の classifyReactionWorkflow は unicode 文字で照合する
// ため、ワークフロー対象の名前だけ unicode に写像してから渡す。対象外は null。
const SLACK_REACTION_UNICODE: Record<string, string> = {
  // start-impl（👍 系）
  "+1": "👍",
  thumbsup: "👍",
  ok: "🆗",
  // repo-memory-good（😄 系）
  smile: "😄",
  smiley: "😄",
  grinning: "😀",
  smiley_cat: "😺",
  // memoria-note（👀）
  eyes: "👀",
  // memoria-task（📝 / ✅ 系）
  memo: "📝",
  pencil: "📝",
  pencil2: "✏️",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  ballot_box_with_check: "☑️",
  // list-local-prs（📋）
  clipboard: "📋",
  // repo-memory-bad（😡 / 👎 系）
  rage: "😡",
  angry: "😠",
  "-1": "👎",
  thumbsdown: "👎",
};

/** Slack 絵文字名 → unicode（ワークフロー対象のみ）。skin-tone 接尾は除去。対象外は null。 */
export function slackReactionToUnicode(name: string): string | null {
  const base = (name ?? "").trim().split("::")[0];
  return SLACK_REACTION_UNICODE[base] ?? null;
}

/**
 * transcript.frame を Slack に中継すべきか判定し、本文を抽出する。
 * discord/egress.ts と同じ意味論:
 *   - kind=text && role=assistant : AI の人間向け本文
 *   - kind=summary                : 会話要約
 *   - それ以外 (tool-use/result/thinking/raw/user) は null（中継しない）
 * 未構造化 ask のfail-loud化・本文ベースの drop フィルタ (guardian JSON 等) も適用する。
 * @implements spec/feature/discord-lictor-relay.md — ask マーカーの fail-loud 中継
 */
export function extractRelayableFrame(
  kind: string,
  payload: unknown,
): { role: "assistant" | "summary"; text: string } | null {
  return extractRelayableTextFrame(kind, payload);
}

/**
 * Slack のメンション記法を通知が発火しない形式にエスケープする。
 * AI 出力に <!here>/<@USERID>/<!subteam^...> が含まれていても全員通知や意図しないメンションに
 * ならないよう、Slack が特別解釈する記法を無害化する。
 */
export function sanitizeSlackMentions(text: string): string {
  return (text ?? "")
    .replace(/<!here>/g, "@here")
    .replace(/<!channel>/g, "@channel")
    .replace(/<!everyone>/g, "@everyone")
    .replace(/<!subteam\^[A-Z][A-Z0-9]*(?:\|[^>]*)?>/g, "@group")
    .replace(/<@([A-Z][A-Z0-9]+)>/g, "@$1");
}

/**
 * SessionCardState から Slack の `username` 文字列を組む。
 * 絵文字があれば先頭に付ける。`chat.postMessage` の `username` フィールドに渡すことで
 * ボット名の代わりにペルソナ名が表示される。
 * 注: Slack の `chat.update` は username を変更できないため、最初の postMessage 時のみ有効。
 */
export function buildSessionBotUsername(state: SessionCardState): string {
  const name = (state.who ?? "").trim() || "Concordia";
  const emoji = (state.emoji ?? "").trim();
  return emoji ? `${emoji} ${name}` : name;
}

// マークダウンテーブルの整形は shared/message-blocks.ts の wrapTablesInCode
// (``` コードフェンスで囲んで等幅整列) に一本化した。 旧 reformatMarkdownTables
// (太字パイプ変換) は桁ズレが残るため撤去。

const ANSWER_ACTION_PREFIX = "cc_answer";
const OTHER_ACTION_PREFIX = "cc_answer_other";

/** AskUserQuestion の選択肢ボタン block を組む。action_id に question_id と index を埋める。 */
export function buildQuestionBlocks(
  questionId: number,
  question: string,
  options: Array<string | { label: string; description?: string }>,
): { text: string; blocks: unknown[] } {
  const norm = options.map((o) => (typeof o === "string" ? { label: o } : o));
  const elements = norm.slice(0, 24).map((o, i) => ({
    type: "button",
    text: { type: "plain_text", text: truncateForSlack(labelWithOptionCode(i, o.label), 75), emoji: true },
    value: String(i),
    action_id: `${ANSWER_ACTION_PREFIX}:${questionId}:${i}`,
  }));
  elements.push({
    type: "button",
    text: { type: "plain_text", text: "自由入力", emoji: true },
    value: "other",
    action_id: `${OTHER_ACTION_PREFIX}:${questionId}`,
  });
  const optionLines = norm
    .map((o, i) => `*[${formatOptionCode(i)}]* ${o.label}${o.description ? ` — ${o.description}` : ""}`)
    .join("\n");
  return {
    text: `❓ ${question}`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `❓ *${truncateForSlack(question)}*` } },
      { type: "section", text: { type: "mrkdwn", text: truncateForSlack(optionLines) } },
      { type: "actions", elements },
    ],
  };
}

/**
 * `/concordia <sub> <args...>` の text 部を解析する。`text` は Slack slash command
 * の本文（コマンド名 `/concordia` を除いた残り）。先頭トークンを小文字化して sub に、
 * 残りを args に。空なら sub="help"。
 */
export function parseSlashCommand(text: string): { sub: string; args: string } {
  const t = (text ?? "").trim();
  if (!t) return { sub: "help", args: "" };
  const sp = t.indexOf(" ");
  if (sp < 0) return { sub: t.toLowerCase(), args: "" };
  return { sub: t.slice(0, sp).toLowerCase(), args: t.slice(sp + 1).trim() };
}

/**
 * ボタン action_id (`cc_answer:<questionId>:<index>`) を解析する。
 * 形式不一致なら null（他の interaction を無視するため）。
 */
export function parseAnswerActionId(actionId: string): { questionId: number; answerIndex: number } | null {
  const parts = (actionId ?? "").split(":");
  if (parts.length !== 3 || parts[0] !== ANSWER_ACTION_PREFIX) return null;
  const questionId = Number(parts[1]);
  const answerIndex = Number(parts[2]);
  if (!Number.isInteger(questionId) || !Number.isInteger(answerIndex) || answerIndex < 0) return null;
  return { questionId, answerIndex };
}

export function parseOtherAnswerActionId(actionId: string): { questionId: number } | null {
  const parts = (actionId ?? "").split(":");
  if (parts.length !== 2 || parts[0] !== OTHER_ACTION_PREFIX) return null;
  const questionId = Number(parts[1]);
  if (!Number.isInteger(questionId) || questionId < 1) return null;
  return { questionId };
}
