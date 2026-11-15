import { isAbsolute, resolve } from "node:path";
import { branchCommandWords } from "./task-branch-policy.js";

/**
 * TB-CD: checkout 不一致で止まったセッションが、登録済みの checkout へ戻るための単独の `cd`。
 * linked worktree へ cwd が移ったあと、`cd <登録 checkout>` まで拒否されると自力で戻れなくなる (2026-11-12 実例)。
 * 通すのは記号を含まない `cd <パス>` だけで、行き先は呼び出し側が渡す登録 checkout と workspace root に限る。
 */
export function recoveryCdTarget(command: string | undefined, cwd: string | undefined): string | null {
  const words = branchCommandWords(command);
  if (words.length !== 2 || !/^(?:cd|chdir|set-location|sl|pushd)$/i.test(words[0]!)) return null;
  const path = gitBashDrivePath(words[1]!);
  if (!path || path === "-" || path.startsWith("~")) return null;
  if (!isAbsolute(path) && !cwd) return null;
  return resolve(cwd ?? "", path);
}

/** Git Bash の `/e/Document/Ars` を `E:/Document/Ars` に読み替える (Windows のみ)。 */
function gitBashDrivePath(path: string): string {
  if (process.platform !== "win32") return path;
  const drive = /^\/([a-zA-Z])(\/.*)?$/.exec(path);
  return drive ? `${drive[1]!.toUpperCase()}:${drive[2] ?? "/"}` : path;
}

function pathKey(path: string): string {
  const resolved = resolve(path).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** `cd` の行き先が、渡した戻り先 (登録 checkout / workspace root) のどれかと一致するか。 */
export function isRecoveryCd(command: string | undefined, cwd: string | undefined, destinations: readonly string[]): boolean {
  const target = recoveryCdTarget(command, cwd);
  if (!target) return false;
  const key = pathKey(target);
  return destinations.some(destination => destination.trim() !== "" && pathKey(destination) === key);
}
