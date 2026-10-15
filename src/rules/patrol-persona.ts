/**
 * 巡回チャットの名乗り (spec/feature/patrol-chat.md §8 名乗り)。
 *
 * - 会話の最初の投稿 (pick / event) は、 生成と同じ 1 回の呼び出しで話題をもじった人名を作らせる
 * - 返信・追投稿は会話の最初の名乗りを引き継ぐ (同じ会話で名前を変えない)
 * - 生成された名前が使えない形なら、 決まった一覧から素材に応じて決定的に選ぶ
 *
 * 名前は表示だけに使い、 判定には関わらない (CC-PATROL-01)。
 */

/** 生成した名前が使えないときの控え。 Discutere の役名 (押野 進 等) と同じく、 意味をもじった姓名。 */
export const PATROL_PERSONA_POOL = [
  "巡野 廻",
  "話種 拾",
  "噂坂 聞",
  "流行 追",
  "見出 綴",
  "拾井 種",
  "早耳 伝",
  "旬田 摘",
  "覗見 知",
  "寄道 巡",
  "風評 読",
  "潮目 渡",
] as const;

/** 名前の長さの上限 (Discord webhook username は 80 文字。 接尾辞の分を残す)。 */
export const PERSONA_MAX_CHARS = 16;
const PERSONA_SUFFIX = " (巡回)";

/** Discord が webhook username に許さない語・mention の起点・URL を含む名前は採らない。 */
const FORBIDDEN = /(discord|clyde|everyone|here|https?:|www\.|[@#:`<>*_~|\\/])/i;

/** 生成された名前を表示に使える形へ整える。 使えなければ null。 */
export function sanitizePersonaName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const name = raw.replace(/[「」『』"'“”]/g, "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > PERSONA_MAX_CHARS) return null;
  if (FORBIDDEN.test(name)) return null;
  if (/[\u0000-\u001f]/.test(name)) return null;
  return name;
}

function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 控えの一覧から決定的に選ぶ (同じ素材なら同じ名前)。 */
export function fallbackPersona(key: string): string {
  return PATROL_PERSONA_POOL[hashOf(key) % PATROL_PERSONA_POOL.length];
}

/** 投稿者名 (webhook username / author_label)。 bot であることが分かる接尾辞を付ける。 */
export function personaUsername(name: string): string {
  return `${name}${PERSONA_SUFFIX}`;
}

/**
 * 生成結果の 1 行目の「名前: …」を取り出す。 名前行が無ければ name は null で本文はそのまま。
 */
export function splitPersonaLine(output: string): { name: string | null; body: string } {
  const lines = output.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first < 0) return { name: null, body: "" };
  const m = /^\s*名前\s*[:：]\s*(.+?)\s*$/.exec(lines[first]);
  if (!m) return { name: null, body: output.trim() };
  return { name: sanitizePersonaName(m[1]), body: lines.slice(first + 1).join("\n").trim() };
}

/** run.decision (JSON) に名乗りを足す。 既存の内容は保つ。 */
export function withPersonaDecision(decision: string | null, persona: string): string {
  let base: Record<string, unknown> = {};
  if (decision) {
    try {
      const parsed = JSON.parse(decision) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) base = parsed as Record<string, unknown>;
    } catch {
      // 壊れた decision は名乗りだけで置き換えない (元の文字列を残す)
      base = { previous_decision: decision };
    }
  }
  return JSON.stringify({ ...base, persona });
}

/** run.decision から名乗りを読む。 無ければ null。 */
export function personaOfDecision(decision: string | null): string | null {
  if (!decision) return null;
  try {
    const parsed = JSON.parse(decision) as { persona?: unknown };
    return typeof parsed.persona === "string" ? sanitizePersonaName(parsed.persona) : null;
  } catch {
    return null;
  }
}

/** chat 行の metadata (JSON 文字列) から名乗りを読む。 */
export function personaOfChatMetadata(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { patrol_persona?: unknown };
    return typeof parsed.patrol_persona === "string" ? sanitizePersonaName(parsed.patrol_persona) : null;
  } catch {
    return null;
  }
}
