/**
 * 秘匿語辞書 (Castra の `.claude/state/confidential-terms.json`) を読む adapter (spec/feature/tech-consultation.md §7)。
 *
 * 辞書は Revisor・AIFormat leak-checker と同じ形式 `{ keywords: [{ id, value, match }] }`。
 * 語そのものはログ・記録に出さない。 読めないときは空を返し、 呼び出し側は Cc のプロジェクト名だけで調べる。
 *
 * @implements SPEC-CONSULT-CLOSURE
 */

import { readFile } from "node:fs/promises";

export async function loadConfidentialTerms(path: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { keywords?: Array<{ value?: unknown }> };
    return (parsed.keywords ?? [])
      .map((keyword) => (typeof keyword.value === "string" ? keyword.value.trim() : ""))
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
}
