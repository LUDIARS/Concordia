/**
 * GLab-UnityHub (拡張モジュール) の env 設定 (spec/feature/glab-unity-hub.md §6)。
 *
 * 秘密でない構造化の設定 (ボード・許可 repo・プロジェクト対応) は concordia.config.json の
 * `glabUnityHub` 節に置く。 ここに載せるのは env で上書きできる運転値だけで、 いずれも
 * Hub worker の再起動で効く (設定画面からは変えない)。
 */

import type { SettingDefinition } from "../types.js";

export const GLAB_UNITY_HUB_SETTINGS: readonly SettingDefinition[] = [
  {
    key: "services.glab_unity_hub_guild_id", section: "services",
    label: "GLab-UnityHub: GLab の guild id",
    description: "/glab-unity-token を受ける GLab の Discord サーバー。 未設定ならトークンを発行せず、 Hub も起動しない。 concordia.config.json の glabUnityHub.guildId より優先する。",
    kind: "string", envName: "GLAB_UNITY_HUB_GUILD_ID", dbKey: null, defaultValue: null, editable: false,
  },
  {
    key: "services.glab_unity_hub_port", section: "services",
    label: "GLab-UnityHub: 待受ポート",
    description: "Hub worker の loopback 待受ポート。 正本は Excubitor catalog (concordia-glab-unity-hub) で、 catalog の env から渡す。",
    kind: "integer", envName: "GLAB_UNITY_HUB_PORT", dbKey: null, defaultValue: null, editable: false, minValue: 1, maxValue: 65535,
  },
  {
    key: "services.glab_unity_hub_allowed_countries", section: "services",
    label: "GLab-UnityHub: 許可国",
    description: "CF-IPCountry で許可する国コード (カンマ区切り)。 既定 JP。 T1 (Tor) と XX (不明) は常に許可国外。",
    kind: "string", envName: "GLAB_UNITY_HUB_ALLOWED_COUNTRIES", dbKey: null, defaultValue: "JP", editable: false,
  },
  {
    key: "services.glab_unity_hub_geo_policy", section: "services",
    label: "GLab-UnityHub: 海外接続の扱い",
    description: "許可国外からの接続を block (4403 で切断) するか monitor (記録と通知だけ) にするか。 既定 block。",
    kind: "enum", envName: "GLAB_UNITY_HUB_GEO_POLICY", dbKey: null, defaultValue: "block", editable: false,
    enumValues: ["block", "monitor"],
  },
  {
    key: "services.glab_unity_hub_db_path", section: "services",
    label: "GLab-UnityHub: DB ファイル",
    description: "トークン (ハッシュ)・監査・仕様下書きを置くモジュール所有の SQLite。 既定は Concordia DB と同じ場所の glab-unity-hub.sqlite。",
    kind: "string", envName: "GLAB_UNITY_HUB_DB_PATH", dbKey: null, defaultValue: null, editable: false,
  },
  {
    key: "services.glab_unity_hub_portus_root", section: "services",
    label: "GLab-UnityHub: Portus の場所",
    description: "@ludiars/portus が未導入のとき、 ビルド済み Portus checkout (dist/http, dist/ws) を読む場所。",
    kind: "string", envName: "GLAB_UNITY_HUB_PORTUS_ROOT", dbKey: null, defaultValue: null, editable: false,
  },
];
