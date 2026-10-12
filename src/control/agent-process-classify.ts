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
 *
 * 2026-10-12: Cc は `wt --window 0 new-tab ... cmd /d /s /c node ...lictor.mjs ...` で
 * セッションを開く。Windows Terminal が 1 つも開いていない状態で spawn すると
 * WindowsTerminal.exe 自体がこの起動命令をコマンドラインに持ち、reaper が
 * 「lictor_pid に無い孤児 Lictor」と誤判定して tree-kill し、同じウィンドウの稼働中
 * セッションが全部落ちた (Excubitor 5db1541 でサービスが窓を開かなくなり常態化)。
 * 起動子は wt / OpenConsole / 将来のランチャと増え続けるため、拒否リストに足すのではなく
 * 許可リストにする: 実行ファイル (コマンドラインの先頭トークン、および取れる場合は
 * image 名) が node 系の時だけ分類する。
 */

export type AgentKind = "lictor" | "agent-client";

/** agent プロセス本体として認める実行ファイル名 (basename、小文字)。 */
const NODE_EXECUTABLE_NAMES = new Set(["node", "node.exe", "nodejs"]);

/**
 * コマンドラインの先頭トークン (実行ファイル) を返す。`"..."` で囲まれていれば中身を返す。
 *
 * 例: `"C:\Program Files\nodejs\node.exe" x.mjs` → `C:\Program Files\nodejs\node.exe`
 *     `/usr/bin/node bin/lictor.mjs`               → `/usr/bin/node`
 */
export function commandExecutable(cmd: string): string {
  const trimmed = cmd.trimStart();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    return end < 0 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  return trimmed.match(/^\S+/)?.[0] ?? "";
}

/** パス (Windows / POSIX 区切り両対応) の basename が node 系かを判定する。 */
function isNodeExecutable(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? "";
  return NODE_EXECUTABLE_NAMES.has(base.toLowerCase());
}

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
 * `agent-client` (`tools/concordia-agent-client.mjs`) は 2026-09-07 に廃止され、
 * 新しく生えることは無い (spec/feature/session-process-reaper.md の
 * 「agent-client の廃止」)。 それでも分類を残すのは、 **廃止前から生き残っている
 * 孤児プロセスを回収する必要がある**ため。 走査対象は実行中プロセスの
 * コマンドラインなので、 スクリプト本体が消えていても判定は成立する。
 * 孤児が絶えたと確認できるまで消さないこと。
 *
 * @param cmd プロセスのコマンドライン。
 * 実行ファイルが node 系でないプロセス (shell ラッパ、Windows Terminal 等の起動子) は、
 * コマンドラインに `lictor.mjs` を含んでいても対象外 (null) にする。
 *
 * @param imageName 取得できる場合の image 名 (Excubitor snapshot の `name`)。
 *   取れた場合はこれも node 系であることを必須にする。
 */
export function classifyKind(cmd: string, imageName?: string | null): AgentKind | null {
  if (imageName && !isNodeExecutable(imageName)) return null;
  if (!isNodeExecutable(commandExecutable(cmd))) return null;
  if (/concordia-agent-client/i.test(cmd)) return "agent-client";
  if (/lictor\.mjs/i.test(cmd)) return "lictor";
  return null;
}

/** cmdline から `--session <id>` / `-s <id>` を抽出する。 無ければ null。 */
export function extractSessionId(cmd: string): string | null {
  const m = cmd.match(/(?:--session|-s)\s+(\S+)/);
  return m ? m[1]! : null;
}
