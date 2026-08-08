/**
 * 実行中プロセスが「Concordia が管理する agent プロセスそのものか」を判定する pure 関数群。
 *
 * spawn は `cmd /d /s /c "node <path>/bin/lictor.mjs ..."` の形で Lictor を起動するため、
 * shell ラッパ (`cmd.exe`) のコマンドラインにも `lictor.mjs` が現れる。しかし
 * `sessions.metadata.lictor_pid` に登録されるのは **その子の node** の PID なので、
 * shell ラッパを Lictor 本体と同一視すると「稼働中セッションのラッパが live PID 集合に
 * 含まれない = 孤児」と誤判定される。
 *
 * 起動子は起動されるプロセスではない。ここでは shell ラッパを分類対象から外し、
 * agent プロセス本体 (node / codex ランタイム) だけを `AgentKind` として扱う。
 * ラッパは本体を tree-kill すれば子の終了に伴って自然終了する。
 */

export type AgentKind = "lictor" | "agent-client";

/** shell ラッパの image 名 (snapshot の `name` が取れる場合の判定に使う)。 */
const SHELL_IMAGE_NAMES = new Set([
  "cmd.exe",
  "cmd",
  "sh",
  "bash",
  "dash",
  "zsh",
  "powershell.exe",
  "pwsh.exe",
]);

/**
 * コマンドラインが shell への `-c` / `/c` 委譲かを判定する。
 *
 * 例: `cmd.exe /d /s /c "^"node^" ^"...\bin\lictor.mjs^" ..."` → true
 *     `"node"  "...\bin\lictor.mjs" "claude"`                  → false
 */
export function isShellWrapperCommand(cmd: string): boolean {
  // Windows: cmd[.exe] に任意個の /X フラグが続き /c で委譲する形。
  if (/^\s*"?[^"\s]*\bcmd(?:\.exe)?"?\s+(?:\/\S+\s+)*\/c\b/i.test(cmd)) return true;
  // POSIX: sh/bash/zsh 等の -c 委譲。
  if (/^\s*"?[^"\s]*\b(?:ba|da|z)?sh"?\s+(?:-\S+\s+)*-[A-Za-z]*c[A-Za-z]*\b/.test(cmd)) return true;
  return false;
}

/**
 * cmdline から Lictor / agent-client / 対象外(null) を判定する。
 *
 * @param cmd プロセスのコマンドライン。
 * @param imageName 取得できる場合の image 名 (Excubitor snapshot の `name`)。
 *   コマンドラインの形に依存しない shell ラッパ判定の補強に使う。
 */
export function classifyKind(cmd: string, imageName?: string | null): AgentKind | null {
  if (imageName && SHELL_IMAGE_NAMES.has(imageName.toLowerCase())) return null;
  if (isShellWrapperCommand(cmd)) return null;
  if (/concordia-agent-client/i.test(cmd)) return "agent-client";
  if (/lictor\.mjs/i.test(cmd)) return "lictor";
  return null;
}

/** cmdline から `--session <id>` / `-s <id>` を抽出する。 無ければ null。 */
export function extractSessionId(cmd: string): string | null {
  const m = cmd.match(/(?:--session|-s)\s+(\S+)/);
  return m ? m[1]! : null;
}
