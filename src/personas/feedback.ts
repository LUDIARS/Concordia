/**
 * session-end 時に persona へのフィードバックを生成する.
 *
 * - session 中に persona 名で投稿された chat の発言サンプルを集める
 * - claude CLI で 1 文の "学んだ note" を要約 (失敗 / disable 時は heuristic fallback)
 * - learned_notes に追記 + persona_feedback_log に記録
 * - 「人格膨張」を防ぐため、1 セッション 1 件、 80 文字以下を強制
 */

import type { PersonaRow, PersonasRepo } from "../db/personas-repo.js";
import type { ChatRepo } from "../db/chat-repo.js";
import type { SessionRow } from "../shared/types.js";
import { runClaude } from "../rules/claude-runner.js";
import { eventBus } from "../events.js";
import { createChildLogger } from "../shared/logger.js";

const log = createChildLogger("persona-feedback");

export interface FeedbackDeps {
  personas: PersonasRepo;
  chat: ChatRepo;
}

/**
 * session-end で呼ぶ. persona に 1 件の note を learned_notes に追記し、 log に残す.
 * 失敗しても session-end 全体を阻害しない (try/catch で内部完結).
 */
export async function applySessionEndFeedback(
  deps: FeedbackDeps,
  session: SessionRow,
  persona: PersonaRow,
): Promise<void> {
  try {
    const samples = collectChatSamples(deps.chat, session.id, persona.name);
    const note = await summarize(samples, persona);
    if (!note) return;
    const trimmed = note.trim().slice(0, 80);
    if (!trimmed) return;
    deps.personas.appendLearnedNote(persona.id, trimmed);
    deps.personas.appendFeedback({
      persona_id: persona.id,
      session_id: session.id,
      kind: "session-end",
      delta: trimmed,
      detail: { sample_count: samples.length },
    });
    eventBus.emit({
      type: "persona.feedback",
      persona_id: persona.id,
      session_id: session.id,
      kind: "session-end",
      ts: Math.floor(Date.now() / 1000),
    });
    log.info({ persona_id: persona.id, session_id: session.id, note: trimmed }, "persona feedback applied");
  } catch (err) {
    log.warn({ err: (err as Error).message, persona_id: persona.id }, "persona feedback failed (skipped)");
  }
}

function collectChatSamples(chat: ChatRepo, session_id: string, persona_name: string): string[] {
  const all = chat.list({ limit: 200 });
  return all
    .filter((m) => m.session_id === session_id || m.author_label === persona_name)
    .filter((m) => m.channel !== "system")
    .map((m) => `[${m.channel}] ${m.author_label}: ${m.text.slice(0, 120)}`)
    .slice(-30); // 直近 30 件
}

async function summarize(samples: string[], persona: PersonaRow): Promise<string | null> {
  if (samples.length === 0) return null;

  if (process.env.CONCORDIA_DISABLE_CLAUDE === "1") {
    return heuristicNote(samples, persona);
  }

  const prompt = [
    `あなたは Concordia の "人格学習エージェント" です. ${persona.name} (= "${persona.description}") というロールが`,
    `1 セッションを終えたところ. このセッション中の chat 発言サンプルを見て、`,
    `**この人格に追記すべき新しい癖 / 傾向 / 学んだ語彙** を 1 つだけ、 **80 文字以下の 1 文** で書いてください.`,
    "",
    "## 制約",
    "- 既存の traits / speech_style と重複してはいけない (新規追加分のみ)",
    "- 内容は中立的・前向き・後の世代でも使える形で",
    "- 不要なら出力なしで OK (空文字列を返す)",
    "- **80 文字以下、 1 文、 \"〜する傾向\" / \"〜と表現する癖\" 等の癖記述形式**",
    "",
    "## 既存の人格",
    `description: ${persona.description}`,
    `speech_style: ${persona.speech_style}`,
    `traits: ${persona.traits}`,
    `learned_notes (既存): ${persona.learned_notes}`,
    "",
    "## chat 発言サンプル (時系列, 最大 30 件)",
    samples.join("\n"),
    "",
    "## 出力 (JSON 1 つだけ. 余計な前置きなし)",
    `{"note":"<80 字以下の 1 文 / 不要なら空文字列>"}`,
  ].join("\n");

  const r = await runClaude(prompt);
  if (!r.ok) return heuristicNote(samples, persona);
  try {
    const m = /\{[\s\S]*?\}/.exec(r.stdout);
    if (!m) return heuristicNote(samples, persona);
    const parsed = JSON.parse(m[0]);
    if (typeof parsed.note === "string" && parsed.note.trim().length > 0) {
      return parsed.note.trim();
    }
    return null;
  } catch {
    return heuristicNote(samples, persona);
  }
}

/** AI 失敗 / 無効時の最低限 fallback. 発言数だけを記録. */
function heuristicNote(samples: string[], persona: PersonaRow): string | null {
  if (samples.length === 0) return null;
  const counted = samples.filter((s) => s.includes(persona.name)).length;
  if (counted === 0) return null;
  return `直近セッションで ${counted} 件の発言を観測 (heuristic fallback).`;
}
