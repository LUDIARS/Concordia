/**
 * 中断したセッションを `claude --resume` で起動し直すための会話 id と作業ディレクトリを読む
 * (spec/feature/usage-budgets.md §5.2)。
 *
 * - 会話 id: Claude Code の transcript のファイル名 (`<会話 id>.jsonl`)。
 * - 作業ディレクトリ: transcript の先頭の `cwd` (会話を始めた場所)。 claude は起動した cwd の project フォルダから
 *   会話を探すので、 セッションが途中で別の worktree へ移っていても会話を始めた場所で起動し直す。
 *   読めなければセッションの repo_path に倒す。
 *
 * @implements SPEC-USAGE-BUDGET-SUSPEND
 */

import type { SessionRow } from "../shared/types.js";
import { readLines, resolveSessionTranscript } from "./log-usage.js";
import { conversationIdFromTranscript } from "./budget-suspension.js";

const HEAD_LINES = 50;

export interface ConversationLaunch {
  conversationId: string | null;
  cwd: string | null;
}

/** transcript の先頭行から最初の cwd を取る。 */
export function launchCwdFromLines(lines: readonly string[]): string | null {
  for (const line of lines) {
    try {
      const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
      if (typeof cwd === "string" && cwd.trim()) return cwd;
    } catch {
      continue;
    }
  }
  return null;
}

export async function readConversationLaunch(session: SessionRow): Promise<ConversationLaunch> {
  if (session.provider !== "claude-code") return { conversationId: null, cwd: session.repo_path || null };
  const conversationId = conversationIdFromTranscript(session.transcript_path);
  const path = await resolveSessionTranscript(session).catch(() => null);
  const cwd = path ? launchCwdFromLines(await readLines(path, HEAD_LINES).catch(() => [])) : null;
  return { conversationId, cwd: cwd ?? (session.repo_path || null) };
}
