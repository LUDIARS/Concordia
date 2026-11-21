# モデル役割対応表 (role map)

@id CC-MODEL-ROLE-MAP

2026-11-18 neco 指示「古いモデルの参照切り替える / ハードコードを追放 / Lapilli 等の LLM 参照系も全チェック」。

## 目的

LUDIARS の各サービスがモデル ID (`gpt-6-sol`, `claude-opus-4-8` など) を自分で持つと、新モデルが出るたびに
数十リポで古い参照が残る。各サービスは **役割名** (`opus` / `sonnet` / `haiku` / `fable` / `astra` / `sol` / `luna`)
だけを持ち、役割 → モデル ID は Concordia が一か所で決める。
Gemini の `neon` は 2026-11-20 neco 指示「Gemini Neon を使えるようにしたので組み込みたい」で追加した (人間が選んだ方針「Concordia に正式に組み込む」)。
`argon` と Antigravity CLI (`agy`) での起動は同日の neco 指示「agy に切り替えて」「Delegation で Argon と Neon を指定できるようにして」「ベースは Neon です」で追加した。

## 正本

| provider | 役割 | 決め方 |
|---|---|---|
| codex | sol / astra / luna | 役割カタログ (`model_role_snapshots`)。`codex model/list` で毎日自動更新 (sidecar-lifecycle-model-refresh.md) |
| claude | opus / sonnet / haiku / fable | モデルカタログ (Settings → Models) の有効行のうち、系統ごとに `sort_order` が最小の行。無ければ `INITIAL_CLAUDE_ROLE_MODELS` |
| gemini | neon / argon | Claude と同じ決め方 (`gemini-<版>-neon` / `gemini-<版>-argon` の有効行のうち系統ごとに `sort_order` 最小)。無ければ `INITIAL_GEMINI_ROLE_MODELS` (MRM-GEM-01)。既定役割は neon (MRM-GEM-05) |

Cc のコードでモデル ID を書いてよいのは `src/model-catalog/role-policy.ts` の
`INITIAL_ROLE_MODELS` / `INITIAL_CLAUDE_ROLE_MODELS` / `INITIAL_GEMINI_ROLE_MODELS` (初期値) と `src/model-catalog/seed.ts` (カタログの初期行) だけ。
委託テンプレートは役割名だけを持つ (下の「委託テンプレート」)。

## 配布

- `GET /v1/model-catalog/role-map` → `{ schemaVersion: 1, generatedAt, roles: { codex: {...}, claude: {...}, gemini: {...} } }`
- 同じ内容をファイルにも書く。Lapilli one-shot (JS / C++) はこのファイルを同期的に読む。
  - `LUDIARS_MODEL_ROLES_FILE` があればそこ
  - Windows: `%LOCALAPPDATA%\LUDIARS\model-roles.json`
  - それ以外: `$XDG_STATE_HOME/ludiars/model-roles.json` (既定 `~/.local/state`)
- 書くのは、起動直後 (listen 後)、日次更新の後、カタログ・役割の変更 API の後。一時ファイルに書いてから置き換える。
  書けなくても Cc の起動や API 応答は止めない (warn ログのみ)。

## 読み手の規則 (Lapilli one-shot)

1. `LUDIARS_ONESHOT_MODEL_<ROLE>` の明示指定
2. role map ファイル
3. ファイルが無い / 壊れている場合: Claude の `opus` / `sonnet` / `haiku` は Claude Code CLI の同名エイリアスをそのまま渡す。
   それ以外 (Codex・fable) はエラー `model_role_unresolved:<role>`。古い ID への黙った切替はしない。

価格表 (費用の計算) と過去の記録 (審査記録・評価結果) はモデル ID ごとのデータなので対象外。

## 委託テンプレート

Actio f0b8cfc3 (2026-11-19 neco 指示「今回こそハードコード根絶で」)。

- MRM-TPL-01: `delegation_templates.model` は役割名 (`opus` / `sonnet` / `haiku` / `fable` / `sol` / `astra` / `luna` / `neon` / `argon`、Claude は `[1m]` 接尾辞可) を持てる。
  spawn 直前 (`DelegationService.launch`、tier 選定の後) に role map で ID へ解決する。カタログ・役割の変更は再起動なしで次の spawn から効く。
  実装: `src/model-catalog/template-model-role.ts` (解決) / `src/model-catalog/role-map-source.ts` (DB から都度読む口)。
- MRM-TPL-02: 明示的なモデル ID (`claude-opus-5-5` 等) はそのまま使う (上書きの互換)。`auto` や空も変えない (例外: provider `agy` の空は既定役割 neon、MRM-GEM-05)。
- MRM-TPL-03: 役割名なのに解決できない (provider と系統が違う、Codex に `[1m]`、role map に無い) ときは spawn しない。
  エラー `delegation_model_role_unresolved:<role>` を返す。古い ID へ黙って戻さない。`effective_model` には解決後の ID を記録する。
- MRM-TPL-04: migration 148 (`src/db/template-model-roles-migration.ts`) が既存行の ID を役割名へ移す。
  `claude-<系統>-*` → 系統名 (provider claude の行だけ)、`gpt-*-sol|astra|luna` → 同名、`gpt-*-terra` → `luna` (provider codex / codex-sdk の行だけ)。
  人が固定した行の記録があるのは追随表 (`delegation_model_following`) から外された `sol-6-1` だけなので、それだけ残す。
  拠点別の上書き (`delegation_template_overrides.patch_json`) は人の明示指定なので触らない。
  戻すときは、役割名を当時の ID へ戻す UPDATE を次の migration で行う (既存 migration は書き換えない)。
- MRM-TPL-05: seed (`src/delegation/seed.ts`) も役割名で書く。
  `bounty-triage-review` は `sonnet` を保存する。起動時の seed upsert が既存行の ID を保ってモデル指定を更新する。
  seed が配布する日次 2 人レビューと `review-duo` の指示文は Claude CLI の `--model opus` を使い、`review-duo` の Sol は `sol` 委託で起動する。
  Actio: `actio:8c09322f-3a33-4728-b052-11658eca73a0`。
- MRM-TPL-06: テンプレートの call_name もモデルの版・廃止した役割を含めない (Actio eddd123d、2026-11-20 neco 指示「Delegation template も古いね」。
  MRM-TPL-05 の旧記述「call_name は改名しない」は撤回)。
- MRM-TPL-07: 委託を通らないセッション起動 (`POST /v1/admin/spawn-session`) も MRM-TPL-01..03 と同じく解決する
  (2026-11-21 neco 指示「Astra 起動で astra は知らないモデル」→「対応」)。
  対象は (a) テンプレの provider と model だけを採る素のセッション (`template` 指定・`inject_prompt` なし。部署ユースケースの起動もここ) と、
  (b) provider 直接指定の `model`。どちらも spawn 直前に role map で ID へ解決し、解決できなければ 400 `delegation_model_role_unresolved:<role>` で起動しない。
  役割名のまま `--model astra` で起動すると、Codex が `The 'astra' model is not supported` (model_not_found) で最初のターンから止まっていた。
  実装: `src/api/register-core.ts` (`currentModelRoles` + `resolveTemplateModel`)。テスト: `tests/spawn-session-model-role.test.ts`。

### 委託テンプレートの名前

| 旧名 | 新名 | 備考 |
| --- | --- | --- |
| `opus-5-5` | `opus` | |
| `sonnet-5-5` | `sonnet` | |
| `fable-5-1` | `fable` | |
| `sol-6-1` | `sol` | Astra With Sidecar の子、固定 (pin) の判定もこの名前で行う |
| `terra-xhigh` | `luna-xhigh` | Terra は廃止済み。model はすでに `luna` |
| `claude-sonnet-5-ask` | `sonnet-ask` | Director 問診 (`CONCORDIA_DIRECTOR_ASK_CALL_NAME` の既定) |
| `claude-sonnet-5-walk` | `sonnet-walk` | 散歩セッション (`CONCORDIA_CURIOSITY_CALL_NAME` の既定) |
| `design-hard-fable5` | `design-hard-fable` | |
| `sol-mid` / `sonnet-mid` / `opus-5-5-movable` / `fable-5-1-movable` | `sol` / `sonnet` / `opus` / `fable` | 以前の別名も新名へ 1 段で解決する |

`haiku` / `luna` / `astra-mid` など版の無い名前はそのまま。`gemma4-12-impl` はローカル LLM のモデル名 (Gemma 4 12B) そのものを指すため今回は改名しない (要確認として残す)。
同じ役割を使う用途別テンプレート (`sonnet` と `sonnet-ask` / `sonnet-walk`) は用途ごとに残し、名前だけ揃える。

- 解決表方式を採る (alias 行は作らない)。正本は `src/delegation/template-call-names.ts` の `TEMPLATE_CALL_NAME_RENAMES`。
  `DelegationRepo.findTemplateByCallName` が完全一致で見つからないときに旧名 → 新名で引き直すので、invoke・テンプレート参照 API・
  Director/散歩の env に旧名が残っていても新名のテンプレートが起動する。Discord の `/spawn` と forum の旧テンプレ選択回答も同じ表で解決する。
- 既存 DB 行は migration 149 (`src/db/template-call-name-roles-migration.ts`) が id を変えずに call_name だけ改名する。
  prompt 編集の記録・追随表・拠点別上書きは id で結び付いているのでそのまま付いてくる。新名の行がすでにあれば改名しない (旧名の行が残り、旧名はその行に解決する)。
  seed も同じ表で改名を試みる (migration 済みなら何もしない)。
- 進行中・過去の run の `delegation_runs.call_name` は起動時の名前の記録なので書き換えない。旧名で invoke した run には新名が記録される。
- 子会社所有の delegation (`subsidiary_delegations`) は子会社側の名前空間なので改名しない。
- 戻すときは次の migration で新名 → 旧名へ UPDATE し、解決表の向きも戻す。

## Gemini (neon / argon)

2026-11-20 neco 指示「Gemini Neon を使えるようにしたので組み込みたい」。Gemini 4 Neon (API model ID `gemini-4-neon`、2026-11-18 Google 公開)。
同日の neco 指示「agy に切り替えて」「Delegation で Argon と Neon を指定できるようにして」「ベースは Neon です」で Gemini 4 Argon (`gemini-4-argon`) と
Antigravity CLI (`agy`) での起動を足した。Gemini CLI は Gemini 4 向けに調整されていない旨の公式案内があるため、Gemini 4 系は agy で起動する。

- MRM-GEM-01: role map の `roles.gemini` は、モデルカタログの provider `gemini` の有効行のうち `^gemini-<版>-(neon|argon)$` に合う行を
  系統ごとに `sort_order` 最小で採る。無ければ `INITIAL_GEMINI_ROLE_MODELS` (`src/model-catalog/role-policy.ts`、`{ neon: "gemini-4-neon", argon: "gemini-4-argon" }`)。
  Claude と同じ関数 `pickCatalogFamilies` (`src/model-catalog/role-map.ts`) を使う。他 provider の行・`gemini-2.5-pro` や `gemini-4-argon-high` など別系統の行は採らない。
  カタログの初期行 (`src/model-catalog/seed.ts`) に `gemini-4-neon` (sort_order 5) と `gemini-4-argon` (sort_order 6) を足し、既存 DB にも起動時の upsert で入る。
  `gemini-2.5-*` の行はそのまま残す。カタログ (ModelProvider) に `agy` は足さない。agy はカタログの `gemini` 行を共有する (Web の候補表示も同じ)。
- MRM-GEM-02: 委託テンプレートの役割名に `neon` / `argon` を足す (`src/model-catalog/template-model-role.ts`)。provider `gemini` / `agy` のときだけ解決する。
  `[1m]` 接尾辞は Claude 専用なので `neon[1m]` / `argon[1m]` は止める。Claude / Codex で `neon` / `argon`、Gemini 系で `opus` / `sol` などは従来どおり `delegation_model_role_unresolved`。
- MRM-GEM-03: 実装委託テンプレート `neon` (Gemini Neon、provider `agy`、model `neon`、💎、sort_order 14 = Astra の直後。
  2026-11-21 neco 指示「Neon を Astra の下に」で 28 から変更) と
  `argon` (Gemini Argon、provider `agy`、model `argon`、🔷、sort_order 29) を seed に足す (`src/delegation/seed.ts`)。
  call_name に版を含めない (MRM-TPL-06)。seed は起動時 upsert で内容を上書きするので、既存 DB で provider `gemini` だった `neon` 行も次の起動で `agy` になる。
- MRM-GEM-04: provider `agy` (Antigravity CLI) を委託・spawn の provider に足す。実 spawn は `lictor agy` + `--model <ID>`
  (`src/control/provider-preset.ts` `resolveDelegationSpawn`)。セッション登録は Lictor が `antigravity-cli` で行い、`toSpawnProvider` が `agy` に写す
  (`src/api/sessions/shared.ts`)。agy は transcript / recovery 解析を持たない (`src/providers/index.ts` は null)。表示名は `Antigravity`、Discord のエージェント絵文字は 🪐
  (`src/discord/formatter.ts`)。既存の provider `gemini` (Gemini CLI) は残す。
- MRM-GEM-05: Gemini 系の既定役割は `neon`。`argon` は明示指定のみ。provider `agy` で model が空 (未指定) の委託は役割 `neon` として role map で解決し、
  `--model <neon の ID>` を明示して起動する (agy 側の既定値に頼らない)。role map を通らない直接 spawn 経路で model が空のときは
  `INITIAL_GEMINI_ROLE_MODELS.neon` を付ける。並び (カタログ・テンプレートの sort_order) も Neon を Argon より先に置き、Web の model 未指定表示は「既定: Neon」とする
  (`web/src/pages/delegation/model.ts` の `emptyModelLabel` / `catalogProviderFor`)。
- 範囲外: Lapilli one-shot の Gemini 対応 (今回は不要と人間が判断)、Gemini CLI の更新、`gemini-4-hydrogen` / `gemini-3.8-flash`、agy の `--effort` 連携。
- 戻すとき: コミットを revert する。既存 DB に入った `gemini-4-neon` / `gemini-4-argon` 行は Settings → Models で無効 (`is_active=0`) にする
  (起動時の upsert は `is_active` を上書きしない)。provider `agy` の委託テンプレート行は revert 後の seed で `neon` が `gemini` に戻り、`argon` は Delegation 画面で無効にする。

## 表示・判定もモデル ID の列挙を持たない

- Discord の webhook 表示名 (`src/discord/webhook-identity.ts`) は ID の形 (`claude-<系統>-<major>[-<minor>]`、`gpt-<版>-<役割>`) から導く。
- Codex の effort 対応判定 (`src/control/provider-preset.ts`) は `gpt-<世代>` の数値で判定し、役割名も受ける (gpt-7 で壊れない)。
- モデルカタログの seed は、有効行を role-policy の現行値に揃え、旧世代の行は無効で残す。
