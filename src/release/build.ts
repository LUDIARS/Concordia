/**
 * develop クローンのビルド。
 *
 * ビルドコマンドの正本は無い (Excubitor catalog は起動コマンドしか持たない)。 リポによっては
 * ビルド自体が要らないので、 **package.json に build script があれば `npm ci && npm run build`、
 * 無ければビルドしない** という規則にする (無言で握りつぶさず、 何をしたかは呼び出し側に返す)。
 *
 * spec/feature/develop-confirm-flow.md §9。
 */

import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** npm ci + build は重い (依存インストールを含む)。 */
const BUILD_TIMEOUT_MS = 15 * 60_000;

export interface BuildResult {
  ok: boolean;
  /** ビルドを実行したか (false = build script が無いのでスキップ)。 */
  ran: boolean;
  error?: string;
}

/** package.json に build script があるか。 */
export function hasBuildScript(repoPath: string): boolean {
  const pkgPath = join(repoPath, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.build === "string" && pkg.scripts.build.trim() !== "";
  } catch {
    return false;
  }
}

export async function buildClone(repoPath: string): Promise<BuildResult> {
  if (!hasBuildScript(repoPath)) return { ok: true, ran: false };
  try {
    await run(repoPath, ["ci"]);
    await run(repoPath, ["run", "build"]);
    return { ok: true, ran: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || err.message || "build failed").trim();
    return { ok: false, ran: true, error: detail.slice(-1500) };
  }
}

function run(cwd: string, args: string[]): Promise<unknown> {
  // Windows では npm は npm.cmd。 shell: true にすると引数のエスケープ事故が出るので
  // 実行ファイル名側で吸収する。
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  return execFileAsync(npm, args, { cwd, timeout: BUILD_TIMEOUT_MS, windowsHide: true });
}
