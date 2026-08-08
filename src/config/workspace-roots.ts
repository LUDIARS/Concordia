/**
 * ワークスペースルート (= ローカルクローンを並べた親ディレクトリ) の env 解決。
 *
 * `CONCORDIA_WORKSPACE_ROOT` / `CONCORDIA_WORKSPACE_ROOTS` / `LUDIARS_ROOT` の
 * 3 キーの読み方は、 集約前は shared/config.ts・control/spawner.ts・
 * delegation/windows-path-recovery.ts の 3 箇所に別々に書かれていた
 * (dedupe する版としない版が混在し、 ルート追加時に片方だけ直る形だった)。
 * 「どのキーがワークスペースルートか」 の正本はこのモジュール。
 */

import { splitSemicolonList, trimmedEnv } from "./env-parse.js";

/** 正規化パスで重複除去しつつ元の表記を保つ (先頭優先、 空は捨てる) (pure)。 */
export function dedupeWorkspaceRoots(roots: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of roots) {
    const trimmed = root.trim();
    if (!trimmed) continue;
    const key = trimmed.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * env で構成されたワークスペースルートの全体集合 (重複除去済み)。
 *
 * 「この配下は repo コンテナであってセッションの作業ディレクトリではない」 を判定する
 * ガード側 (spawner の禁止ルート / Windows パス復元) が使う。 優先順位ではなく
 * 集合が欲しい用途なので、 プライマリの決定は行わない
 * (プライマリ = `ConcordiaConfig.workspaceRoot` は shared/config.ts の責務)。
 */
export function readConfiguredWorkspaceRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return dedupeWorkspaceRoots([
    trimmedEnv(env.CONCORDIA_WORKSPACE_ROOT) ?? "",
    ...splitSemicolonList(env.CONCORDIA_WORKSPACE_ROOTS),
    trimmedEnv(env.LUDIARS_ROOT) ?? "",
  ]);
}

/** `CONCORDIA_WORKSPACE_ROOTS` (追加ルート列) だけを配列化する。 */
export function readExtraWorkspaceRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return splitSemicolonList(env.CONCORDIA_WORKSPACE_ROOTS);
}
