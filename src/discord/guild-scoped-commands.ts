/**
 * 特定の guild にだけ登録する slash command (登録時の絞り込み)。
 *
 * `/glab-unity-token` は GLab の Discord サーバー (設定 `GLAB_UNITY_HUB_GUILD_ID` /
 * `glabUnityHub.guildId`) にだけ出す。 本社・他の子会社には登録しない。 GLab が子会社 guild でも
 * 本社 guild でも同じ規則で決まる。 実行時の guild 確認は use case 側でも行う (二段防御)。
 *
 * @implements spec/feature/glab-unity-hub.md §1 (GUH-TOKEN)
 */

import { loadGlabUnityHubConfig } from "../glab-unity-hub/adapters/hub-config.js";

/** guild を限定するコマンド名 → その guild id を返す関数。 */
const GUILD_SCOPED: Readonly<Record<string, () => string | null>> = {
  "glab-unity-token": () => {
    try {
      return loadGlabUnityHubConfig().guildId;
    } catch {
      // 設定ファイルが壊れていても他のコマンドの登録は止めない (このコマンドだけ出さない)。
      return null;
    }
  },
};

export function isGuildScopedCommand(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(GUILD_SCOPED, name);
}

/** guild 限定のコマンドを、 この guild に登録してよいか。 限定の無いコマンドは常に true。 */
export function isCommandAvailableInGuild(
  name: string,
  guildId: string | null | undefined,
  resolve: (name: string) => string | null = (n) => GUILD_SCOPED[n]?.() ?? null,
): boolean {
  if (!isGuildScopedCommand(name)) return true;
  if (!guildId) return false;
  const target = resolve(name);
  return target !== null && target === guildId;
}
