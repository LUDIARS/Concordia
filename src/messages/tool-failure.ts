/**
 * 失敗したツール呼び出しの「何が失敗したか」を組み立てる純関数。
 *
 * これまで session_messages に残るのは `失敗` の 1 語だけで、 どのコマンドが
 * どう落ちたのかは provider の transcript を直接読むしかなかった (neco 指摘 2026-09-01:
 * 「Bash 失敗時に Cc の WebUI で何が失敗したか見れるようにしよう」)。
 *
 * 素材は Lictor が送る transcript frame に既にある:
 *   - tool-use   `input_preview`  … 入力の先頭 200 字 (Claude は JSON, Codex はコマンド行)
 *   - tool-result `preview`       … 結果の先頭 200 字
 * どちらも Lictor 側で 200 字に切られているので、 ここで新たに大きな本文は増えない。
 *
 * 置き場は **メッセージ本文ではなく metadata**。 本文へ足すと Discord の
 * セッションスレッドへもそのまま流れ (egress は tool の失敗だけ中継する)、
 * 生コマンドを出張先や共有チャンネルへ撒くことになる。 WebUI だけが読む面に置く。
 *
 * @implements SPEC-SESSION-TOOL-FAILURE-DETAIL
 */

import { redactSecrets } from "../shared/redact-secrets.js";

/** WebUI が読む失敗の内訳。 いずれも空文字なら「取れなかった」を意味する。 */
export interface ToolFailureDetail {
  /** ツール名 (Bash / Edit / …)。 */
  tool: string;
  /** 実行しようとした内容 (Bash ならコマンド行)。 */
  command: string;
  /** 失敗の出力 (stderr / エラーメッセージ)。 */
  error: string;
}

/** metadata / 表示に載せる 1 項目あたりの上限。 素材は Lictor 側で 200 字。 */
const FIELD_LIMIT = 400;

/**
 * ツール入力プレビューから「実行しようとした内容」を取り出す。
 *
 * `input_preview` は 200 字で切られた JSON なので **パースできないことが多い**。
 * パースできたら代表フィールドを、 だめなら `"command"` 等をゆるく拾い、
 * それも無ければプレビューそのものを返す (取れないものを黙って捨てない)。
 */
export function extractToolCommand(inputPreview: string): string {
  const preview = inputPreview.trim();
  if (!preview) return "";
  const parsed = tryParseObject(preview);
  if (parsed) {
    for (const key of ["command", "file_path", "url", "query", "prompt"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) return clip(value.trim());
    }
    return clip(preview);
  }
  // 途中で切れた JSON からの緩い抽出。 `"command":"…` の値部分だけを取る。
  const loose = /"(?:command|file_path|url|query)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(preview);
  if (loose?.[1]) return clip(decodeJsonStringContent(loose[1]));
  return clip(preview);
}

/**
 * 失敗したツール呼び出しの内訳を組み立てる。 何も素材が無ければ `null` を返し、
 * 呼び出し側は古い詳細を明示的に消す (空の詳細を出して「詳細あり」に見せない)。
 */
export function buildToolFailureDetail(input: {
  tool: string;
  inputPreview: string;
  resultPreview: string;
}): ToolFailureDetail | null {
  const tool = clip(input.tool.trim());
  const command = extractToolCommand(input.inputPreview);
  const error = clip(input.resultPreview.trim());
  if (!command && !error) return null;
  return { tool, command, error };
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    // 200 字で切られた JSON はここに来る。 呼び出し側が緩い抽出へ回す。
    return null;
  }
}

function decodeJsonStringContent(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    // The loose matcher excludes incomplete trailing escape sequences. Keep the
    // original content if a non-JSON producer emitted another invalid escape.
    return value;
  }
}

/**
 * 資格情報らしき断片を伏せてから長さを詰める。 失敗したコマンドと stderr は
 * `token=…` や `Bearer …` をそのまま含みうるので、 保存・表示の前に必ず通す。
 */
function clip(text: string): string {
  const safe = redactSecrets(text);
  return safe.length > FIELD_LIMIT ? `${safe.slice(0, FIELD_LIMIT).trimEnd()}…` : safe;
}
