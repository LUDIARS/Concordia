/**
 * 中央チャット発話描画 (Haiku).
 *
 * Concordia のエージェント間チャットの **発話文だけ** を 1 回の軽量 LLM 呼び出しで描画する.
 * 「いつ / 誰が喋るか」 の判断は呼び出し側 (rules/decide.ts・dispatcher.ts) が決定的に行い、
 * ここは渡された persona の声色で 1 文を組み立てるだけ (= 描画の単一責任).
 *
 * モデルは Haiku 固定運用. 2 モード (LUDIARS は API 不使用 = claude CLI 経由):
 *  - "cli"       : `claude -p --model <model>` (サブスク Haiku). 既定.
 *  - "template"  : LLM 非使用. seed 文字列をそのまま返す (明示オプトアウト時のみ)
 *
 * Anthropic API 直叩き経路 ("haiku-api") は撤去済み
 * (policy: LUDIARS は API キーを使わず claude CLI で描画する).
 */

import type { ChatChannel } from "../db/chat-repo.js";
import { runClaude } from "../rules/claude-runner.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("chat-render");

export type ChatRenderer = "cli" | "template";

/** 発話の意図. prompt の組み立てと文体を切り替える. */
export type ChatIntent =
  | "chitchat" // 雑談
  | "review" // 軽レビュー / 振り返り
  | "reply" // 他者発言への返信
  | "react" // 動作ログ等への反応
  | "notice" // 離脱通知などの軽い告知
  | "consult"; // 相談 / 確認

/** 描画に使う人格の声色 (DB の PersonaRow から最小限を抜いたもの). */
export interface PersonaVoice {
  /** ロール名 (例 "テスト魂"). */
  name: string;
  /** chat author_label に使う人物名 (例 "境野 詰"). 空なら name を使う. */
  display_name: string;
  description?: string;
  traits?: string[];
  speech_style?: string;
}

export interface RenderContext {
  /** 直近 chat 行 (`[channel] author: text` 形式, 時系列). 重複回避の材料. */
  recent?: string[];
  /** 返信 / 反応の対象テキスト (reply / react / consult 用). */
  trigger?: string;
  /** 文体の種を与える seed 文 (chitchat の new-area / pure 等). */
  seed?: string;
  /** ルール / タスク由来の追加指示 (任意). */
  extra?: string;
  /** 対象セッションのロール表記 (persona 未割当時の素材). */
  role?: string;
}

export interface RenderRequest {
  persona: PersonaVoice;
  channel: ChatChannel;
  intent: ChatIntent;
  context: RenderContext;
}

export interface RenderConfig {
  renderer: ChatRenderer;
  /** cli の `--model` に渡すエイリアス (例 "haiku"). */
  model: string;
}

const INTENT_GUIDE: Record<ChatIntent, string> = {
  chitchat: "ロールの関心領域に紐づく軽い雑談を 1 文.",
  review: "直近作業の振り返りを 1〜3 行 (うまくいった点 / 引っかかり / 次の手).",
  reply: "相手の発言への短い返信を 1 文. 同意・補足・茶々のいずれか.",
  react: "提示されたログ更新への短い反応を 1 文. 言うことが無ければ短い相槌で可.",
  notice: "事実を 1 文で軽く共有. 大げさにしない.",
  consult: "相手に確認 / 相談を促す短い 1 文.",
};

/**
 * 発話文を 1 つ描画する. 描画不能 (失敗 / キー不在 / 空) なら null.
 * 返り値は前後の引用符・コードフェンス・余計な前置きを除去済の素のテキスト.
 */
export async function renderChat(req: RenderRequest, cfg: RenderConfig): Promise<string | null> {
  if (cfg.renderer === "template") {
    return renderTemplate(req);
  }

  const prompt = buildRenderPrompt(req);

  // cli (既定・唯一の LLM 経路). LUDIARS は API キーを使わないため claude -p で描画する.
  return renderViaCli(prompt, cfg);
}

async function renderViaCli(prompt: string, cfg: RenderConfig): Promise<string | null> {
  const r = await runClaude(prompt, { model: cfg.model });
  if (!r.ok) {
    log.warn({ stderr: r.stderr.slice(0, 160) }, "chat render via CLI failed");
    return null;
  }
  return sanitize(r.stdout);
}

/** template モード: LLM を使わず seed / trigger をそのまま短文化して返す. */
function renderTemplate(req: RenderRequest): string | null {
  const { seed, trigger } = req.context;
  const base = seed ?? trigger ?? "";
  const text = base.trim().slice(0, 120);
  return text.length > 0 ? text : null;
}

export function buildRenderPrompt(req: RenderRequest): string {
  const p = req.persona;
  const lines: string[] = [
    "あなたは Concordia (LUDIARS のマルチエージェント司会) のチャット発話を 1 つだけ書きます.",
    "渡された人格の声色になりきり、 指定 channel に流す 1 発言を出力してください.",
    "",
    "## 出力規約",
    "- 出力は **発話本文のみ**. 前置き・引用符・コードフェンス・JSON は一切付けない.",
    "- 日本語. 120 文字以内 (review のみ 3 行まで可).",
    "- AI 同士の対話前提. 人間への過剰な配慮・敬語は不要、 短く軽く.",
    "- 直近 chat と意味が重複するなら、 角度を変えるか短い相槌にする.",
    "",
    "## 今回の意図",
    INTENT_GUIDE[req.intent],
    "",
    "## なりきる人格",
    `ロール: ${p.name}`,
  ];
  if (p.description) lines.push(`核: ${p.description}`);
  if (p.traits && p.traits.length) lines.push(`特性: ${p.traits.join(", ")}`);
  if (p.speech_style) lines.push(`喋り方: ${p.speech_style}`);
  if (req.context.role && req.context.role !== p.name) {
    lines.push(`(セッション推定ロール: ${req.context.role})`);
  }

  if (req.context.trigger) {
    lines.push("", "## 対象 (これに反応 / 返信する)", req.context.trigger.slice(0, 400));
  }
  if (req.context.seed) {
    lines.push("", "## 文体の種", req.context.seed.slice(0, 200));
  }
  if (req.context.extra) {
    lines.push("", "## 追加指示", req.context.extra.slice(0, 600));
  }
  if (req.context.recent && req.context.recent.length) {
    lines.push("", "## 直近 chat (重複回避用)", req.context.recent.slice(-8).join("\n").slice(0, 1200));
  }

  lines.push("", `## 投稿先 channel: ${req.channel}`, "発話本文のみを出力:");
  return lines.join("\n");
}

/**
 * LLM 出力を chat 1 行に正規化する.
 * - 前後空白除去 / 全体を囲う引用符・コードフェンス除去
 * - 余計な行が付いていたら最初の非空ブロックだけ採る (review は複数行許容)
 */
export function sanitize(raw: string): string | null {
  let t = raw.trim();
  if (!t) return null;

  // コードフェンス全体除去
  const fence = /^```[a-z]*\s*([\s\S]*?)\s*```$/.exec(t);
  if (fence) t = fence[1].trim();

  // 全体を囲う引用符 (" ' 「 」) を 1 重だけ剥がす
  t = stripWrappingQuotes(t).trim();
  if (!t) return null;

  // 2000 字上限 (chat schema)
  return t.slice(0, 2000);
}

function stripWrappingQuotes(s: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["「", "」"],
    ["『", "』"],
  ];
  for (const [open, close] of pairs) {
    if (s.startsWith(open) && s.endsWith(close) && s.length >= open.length + close.length) {
      return s.slice(open.length, s.length - close.length);
    }
  }
  return s;
}
