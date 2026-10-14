/**
 * `claude -p` を起動する実体を決める。
 *
 * Windows では cmd.exe を挟まずに起動したい (シェルの引数クォートとプロセス所有の問題を避ける) ので、
 * 実行ファイルを直接 spawn する。 ネイティブ版は `claude.exe` だが、 npm で入れた拠点には
 * `claude.cmd` (npm の shim) しか無い (2026-10-11 MELPOT: `spawn claude.exe ENOENT` で
 * 連合のワンショット調査が動かなかった)。 shim の中身から起動先を読み、 `.js` なら Node で、
 * `.exe` ならそのまま起動する。
 */
import { readFile } from "node:fs/promises";
import { pathExists } from "../shared/fs-async.js";
import { delimiter, join } from "node:path";

export interface ClaudeLaunch {
  file: string;
  /** claude の引数より前に置く引数 (npm 版の cli.js など)。 */
  prefixArgs: string[];
}

export interface ClaudeLaunchDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean | Promise<boolean>;
  readText?: (path: string) => string | Promise<string>;
  nodePath?: string;
}

/** npm の cmd-shim から `%dp0%\...` の起動先を取り出す。 見つからなければ null。 */
export function npmShimTarget(shim: string): string | null {
  // shim は先に同梱 node.exe の有無を調べるので、それを除いた最後の起動先を採る。
  const targets = [...shim.matchAll(/"%~?dp0%?\\([^"]+?\.(?:js|cjs|mjs|exe))"/gi)]
    .map((match) => match[1]!)
    .filter((target) => !/^node\.exe$/i.test(target));
  return targets.at(-1) ?? null;
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw.split(delimiter).map((dir) => dir.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

export async function resolveClaudeLaunch(deps: ClaudeLaunchDeps = {}): Promise<ClaudeLaunch> {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return { file: "claude", prefixArgs: [] };
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? pathExists;
  const readText = deps.readText ?? ((path: string) => readFile(path, "utf8"));
  const dirs = pathDirs(env);

  for (const dir of dirs) {
    const exe = join(dir, "claude.exe");
    if (await exists(exe)) return { file: exe, prefixArgs: [] };
  }
  for (const dir of dirs) {
    const shim = join(dir, "claude.cmd");
    if (!(await exists(shim))) continue;
    let target: string | null = null;
    try {
      target = npmShimTarget(await readText(shim));
    } catch {
      target = null;
    }
    if (!target) continue;
    const resolved = join(dir, target);
    if (!(await exists(resolved))) continue;
    if (/\.exe$/i.test(resolved)) return { file: resolved, prefixArgs: [] };
    return { file: deps.nodePath ?? process.execPath, prefixArgs: [resolved] };
  }
  // ネイティブ版の既定の置き場所 (PATH に入っていないサービス環境)。
  const home = env.USERPROFILE ?? env.HOME;
  if (home) {
    const native = join(home, ".local", "bin", "claude.exe");
    if (await exists(native)) return { file: native, prefixArgs: [] };
  }
  // 見つからなければ従来どおり名前で起動する (ENOENT がそのまま原因を示す)。
  return { file: "claude.exe", prefixArgs: [] };
}
