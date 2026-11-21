/**
 * 設定 1 件の `dbKey` がどのストアに入るかを決める (読み出しと書き込みで同じ規則を使う)。
 *
 * 明示された `dbStore` が最優先。 省略時はセクション名から決まる (discord / slack / それ以外は schema_meta)。
 * 読み出し (resolve.ts) と書き込み (apply.ts) が別々に決めると、 セクションとストアが 1:1 でない項目
 * (deploy-notify / playtest-notify セクションの Slack webhook は slack_config に入る) が
 * 「書いた先と読む先が違う = 保存したのに未設定のまま」 になるため、 ここ 1 か所に寄せる。
 *
 * @implements spec/feature/playtest-review-notify.md — 認証
 */

import type { SettingDefinition } from "./types.js";

export type SettingStore = NonNullable<SettingDefinition["dbStore"]>;

export function settingStoreOf(definition: Pick<SettingDefinition, "dbStore" | "section">): SettingStore {
  if (definition.dbStore) return definition.dbStore;
  return definition.section === "discord" || definition.section === "slack" ? definition.section : "meta";
}
