/**
 * 設定項目レジストリの型 (W5-1)。
 *
 * `src/discord/conn-config.ts` が Discord 接続設定だけに持っていた
 * 「値の出所 (db|env|default|none)」 の考え方を、 サービス全体の設定へ広げる。
 * ここは型だけを持ち、 項目の定義 (definitions/) と解決 (resolve.ts) は別ファイル。
 */

/** 値の種類。 UI の入力コントロールと PUT の検証に使う。 */
export type SettingValueKind =
  | "boolean"
  | "integer"
  | "string"
  | "string-list"
  | "enum"
  | "secret"
  /**
   * map / 構造化された値 (cron の job→call 対応表、 絵文字→アクション対応表 等)。
   * レジストリは 「存在すること」 と現在値の表示だけを担い、 編集は専用 UI に任せる
   * (`managedBy` を必ず添える)。 汎用 PUT で壊さないため常に `editable: false`。
   */
  | "json";

/**
 * 今の値がどこから来たか。
 *
 * - `db`      … DB (schema_meta / discord_config 等) に保存された上書きがある
 * - `env`     … env で指定されている
 * - `default` … どちらも無く、 コード上の既定値が効いている
 * - `none`    … どちらも無く、 既定値も無い (= 未設定。 機能が無効/不能な状態)
 */
export type SettingSource = "db" | "env" | "default" | "none";

/** 設定ページのセクション id。 表示順は sections.ts が持つ。 */
export type SettingSectionId =
  | "core"
  | "workspace"
  | "llm"
  | "discord"
  | "slack"
  | "session"
  | "compaction"
  | "delegation"
  | "harness"
  | "workflow"
  | "services"
  | "observability"
  | "logging"
  | "cache"
  | "pr-queue"
  | "github"
  | "federation"
  | "runtime";

/** レジストリに載る値の表現。 secret は値を持たない (API に実値を出さないため)。 */
export type SettingValue =
  | boolean
  | number
  | string
  | string[]
  | Record<string, string>
  | null;

/**
 * 設定項目の定義 (静的)。
 *
 * `envName` / `dbKey` の少なくとも一方は非 null。 両方 null の項目は
 * 「どこからも設定できない」 ので定義として誤り (definitions/index.ts が検証する)。
 */
export interface SettingDefinition {
  /** レジストリ内で一意な安定キー。 API / UI がこれで項目を指す。 */
  key: string;
  section: SettingSectionId;
  label: string;
  /** 何を変える設定か。 UI にそのまま出す。 */
  description: string;
  kind: SettingValueKind;
  /** env 名。 env から設定できない項目は null。 */
  envName: string | null;
  /** DB キー (schema_meta / discord_config 等)。 DB 上書きが無い項目は null。 */
  dbKey: string | null;
  /**
   * `dbKey` を引くストア。 省略時はセクション名から決まる (discord / slack / それ以外は
   * schema_meta)。 セクションとストアが 1:1 でない項目 (pr-queue セクションにある
   * Revisor の token は revisor_config に入る) だけが明示する。
   */
  dbStore?: "meta" | "discord" | "slack" | "revisor" | "github";
  /** コード上の既定値。 既定が無い (未設定なら機能しない) 項目は null。 */
  defaultValue: SettingValue;
  /**
   * WebUI / PUT から変更できるか。
   *
   * false は 「env でしか設定できない」 項目 (再起動が要る bind port 等)。
   * 表示はするが編集経路を持たない。 PUT は 400 で拒否する
   * (黙って無視すると 「保存したのに効かない」 になる)。
   */
  editable: boolean;
  /** `kind: "enum"` のときの選択肢。 それ以外では未定義。 */
  enumValues?: readonly string[];
  /** `kind: "integer"` のときに受け付ける下限・上限。 */
  minValue?: number;
  maxValue?: number;
  /** `kind: "string"` の入力制約。値全体に一致する正規表現文字列。 */
  stringPattern?: string;
  /** `stringPattern` 不一致時に API が返す人間向けの制約説明。 */
  stringPatternDescription?: string;
  /** `kind: "string-list"` の env 表現。 既定は既存設定と同じ `;` 区切り。 */
  listEnvFormat?: "semicolon" | "comma-or-newline";
  /**
   * 編集を担う専用 UI / API がある場合、 その場所を示す文字列 (例 `"設定 > cron ジョブ"`)。
   * `editable: false` の項目が 「なぜここで編集できないか」 を UI が説明できるようにする。
   */
  managedBy?: string;
}

/** 定義 + 現在値 + 出所。 API がこの形で返す。 */
export interface ResolvedSetting extends SettingDefinition {
  /** 現在の実効値。 secret 系は常に null (値を返さない)。 */
  value: SettingValue;
  /** secret 系のみ: 値が設定済みか。 secret 以外では undefined。 */
  set?: boolean;
  source: SettingSource;
}
