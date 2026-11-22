/**
 * role map の書き出し先。 Lapilli one-shot (JS / C++) と同じ規則で場所を決める。
 * - LUDIARS_MODEL_ROLES_FILE があればそれ
 * - Windows: %LOCALAPPDATA%\LUDIARS\model-roles.json
 * - それ以外: $XDG_STATE_HOME/ludiars/model-roles.json (既定 ~/.local/state)
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RoleMap } from "./role-map.js";

export function defaultRoleMapPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const explicit = env.LUDIARS_MODEL_ROLES_FILE?.trim();
  if (explicit) return explicit;
  if (platform === "win32") return join(env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local"), "LUDIARS", "model-roles.json");
  return join(env.XDG_STATE_HOME?.trim() || join(home, ".local", "state"), "ludiars", "model-roles.json");
}

/**
 * 読み手が書きかけを読まないよう、 一時ファイルに書いてから置き換える。
 * 役割の変更 API から呼ばれる実行時の経路なので、 ブロックしない I/O で書く (spec/tasks/full-async-io.md)。
 */
export async function writeRoleMapFile(path: string, map: RoleMap): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(map, null, 2)}\n`, "utf8");
  await rename(temp, path);
}
