# モデル役割対応表 (role map)

@id CC-MODEL-ROLE-MAP

2026-11-18 neco 指示「古いモデルの参照切り替える / ハードコードを追放 / Lapilli 等の LLM 参照系も全チェック」。

## 目的

LUDIARS の各サービスがモデル ID (`gpt-6-sol`, `claude-opus-4-8` など) を自分で持つと、新モデルが出るたびに
数十リポで古い参照が残る。各サービスは **役割名** (`opus` / `sonnet` / `haiku` / `fable` / `astra` / `sol` / `luna`)
だけを持ち、役割 → モデル ID は Concordia が一か所で決める。

## 正本

| provider | 役割 | 決め方 |
|---|---|---|
| codex | sol / astra / luna | 役割カタログ (`model_role_snapshots`)。`codex model/list` で毎日自動更新 (sidecar-lifecycle-model-refresh.md) |
| claude | opus / sonnet / haiku / fable | モデルカタログ (Settings → Models) の有効行のうち、系統ごとに `sort_order` が最小の行。無ければ `INITIAL_CLAUDE_ROLE_MODELS` |

Cc のコードでモデル ID を書いてよいのは `src/model-catalog/role-policy.ts` の
`INITIAL_ROLE_MODELS` / `INITIAL_CLAUDE_ROLE_MODELS` (初期値) と `src/model-catalog/seed.ts` (カタログの初期行) だけ。
委託テンプレートの seed は `initialRoleModel(<役割>)` を使う。

## 配布

- `GET /v1/model-catalog/role-map` → `{ schemaVersion: 1, generatedAt, roles: { codex: {...}, claude: {...} } }`
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
