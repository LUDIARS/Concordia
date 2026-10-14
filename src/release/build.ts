/**
 * develop クローンのビルド。
 *
 * ビルドコマンドの正本は無い (Excubitor catalog は起動コマンドしか持たない)。 リポによっては
 * ビルド自体が要らないので、 **package.json に build script があれば `npm ci && npm run build`、
 * 無ければビルドしない** という規則にする (無言で握りつぶさず、 何をしたかは呼び出し側に返す)。
 *
 * spec/feature/develop-confirm-flow.md §9。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runNpm } from "./npm-runner.js";

/** npm ci + build は重い (依存インストールを含む)。 */
const BUILD_TIMEOUT_MS = 15 * 60_000;

export interface BuildResult {
  ok: boolean;
  /** ビルドを実行したか (false = build script が無いのでスキップ)。 */
  ran: boolean;
  error?: string;
}

export type BuildNpmRunner = (cwd: string, args: readonly string[], timeoutMs: number) => Promise<unknown>;

/** package.json に build script があるか。 */
export async function hasBuildScript(repoPath: string): Promise<boolean> {
  const pkgPath = join(repoPath, "package.json");
  try {
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.build === "string" && pkg.scripts.build.trim() !== "";
  } catch {
    return false;
  }
}

export async function buildClone(repoPath: string, npmRunner: BuildNpmRunner = runNpm): Promise<BuildResult> {
  if (!(await hasBuildScript(repoPath))) return { ok: true, ran: false };
  try {
    await npmRunner(repoPath, ["ci"], BUILD_TIMEOUT_MS);
    await npmRunner(repoPath, ["run", "build"], BUILD_TIMEOUT_MS);
    return { ok: true, ran: true };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr || err.message || "build failed").trim();
    return { ok: false, ran: true, error: detail.slice(-1500) };
  }
}
