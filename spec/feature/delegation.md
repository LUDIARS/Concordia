# Delegation Templates — 設計

> AI エージェント間の作業委託フレームワーク。 Claude / Codex / Gemini が
> 「呼び出し名」 で別エージェントに作業を投げ、 Concordia がテンプレ resolve
> + spawn + 履歴記録までを面倒見る。 v0.1 範囲は spawn + prompt render まで
> (auto-inject は別 PR / Lictor 改修)。

## 1. 動機

各エージェントは得意分野が異なる:
- Claude (Opus 4.7): 設計判断、 大規模 refactor、 横断レビュー
- Codex (GPT-5.3): 1-2 ファイルの局所的修正、 高速 typing
- Gemini: (枠だけ用意)

Claude が設計書を仕上げて Codex に実装を投げる、 Claude がレビューして Codex に
修正を投げる、 といった分業のために 「タスクテンプレ」 を予め登録しておき、
呼び出し名で発火できるようにする。

## 2. データモデル (SQLite)

```
delegation_templates
  id (uuid pk)
  call_name (unique, ^[a-z][a-z0-9_-]{0,63}$)
  title (人間向け 1 行)
  description (いつ使うか)
  target_provider ("claude" | "codex" | "gemini")
  model (NULLABLE TEXT — spawn する CLI に `--model` で渡す。 null = provider CLI の config 既定)
  prompt_template (TEXT、 ${var} placeholder)
  input_schema (JSON 配列: [{name, type, required, description, default?}])
  default_cwd (NULLABLE TEXT)
  is_active (INTEGER 0/1)
  created_at, updated_at (epoch ms)

delegation_runs
  id (uuid pk)
  template_id (fk, ON DELETE SET NULL)
  call_name (denormalized — テンプレ削除後も履歴を保つ)
  target_provider
  args_json (TEXT, 入力 args の JSON)
  rendered_prompt (TEXT)
  prompt_file_path (TEXT, 書き出した md path)
  spawn_pid (INTEGER NULL — spawn 失敗時 NULL)
  spawn_command (TEXT, JSON 配列)
  triggered_by (TEXT, free-form caller identifier)
  status ("pending" | "spawned" | "spawn_failed")
  error (TEXT NULL)
  created_at
```

## 3. テンプレ render

- `${var_name}` を args[var_name] で置換
- `${var_name:default}` で default
- args に required な変数が無ければエラー
- input_schema の `type` は `"string" | "number" | "boolean"` のみサポート (v0.1)
- 入力検証で zod を使う

## 4. invoke flow (v0.1)

1. POST /v1/delegation/invoke `{ call_name, args, cwd?, triggered_by?, spawn? }`
2. テンプレ resolve → input_schema validate → render
3. rendered_prompt を `<concordia-data>/delegation/<run_id>.md` に保存
4. `spawn !== false` の場合: `/v1/spawn` 相当の処理を内部実行
   - `template.model` があれば spawn args に `--model <model>` を付与 (Lictor が下層 CLI へ透過)。 null なら付けず provider CLI の config 既定に委ねる
   - rendered_prompt の path を spawn 時 env `CONCORDIA_DELEGATION_PROMPT_FILE` で渡す
   - (Lictor 側の自動 inject は v0.2 — 今は呼び出し元が出力された path を見て手動 paste)
5. delegation_runs に upsert
6. response: `{ run_id, rendered_prompt, prompt_file_path, spawn_pid, spawn_command }`

呼び出し側 (Claude / MCP / CLI) は spawn 後の Codex 端末に prompt を渡す責任を持つ
(v0.1 は手動。 ユーザが新規 tab で `cat <prompt_file_path>` などして貼る運用)。

## 5. API (HTTP)

| Method | Path | Auth | 用途 |
|--------|------|------|------|
| GET    | /v1/delegation/templates | none | 一覧 (is_active=1) |
| GET    | /v1/delegation/templates/all | none | 一覧 (含む inactive) |
| GET    | /v1/delegation/templates/:call_name | none | 1 件取得 |
| POST   | /v1/delegation/templates | none | 新規作成 |
| PATCH  | /v1/delegation/templates/:id | none | 更新 |
| DELETE | /v1/delegation/templates/:id | none | soft delete (is_active=0) |
| POST   | /v1/delegation/invoke | none | テンプレ resolve + spawn |
| GET    | /v1/delegation/runs | none | 直近 100 件 |

mutating endpoint も bearer token を要求しない。 Concordia は loopback
(既定 127.0.0.1:17330) 限定で動き、 `/v1/admin/*` と同じ信頼境界に乗る。
以前は `.spawn.token` を要求していたが、 同じ loopback サービスで Monitor の
spawn は token-free・Delegation CRUD だけ token 必須という非対称が混乱の元
(token 未貼付で Save できない) だったため撤廃。

## 6. MCP server

`src/mcp/delegation-server.ts` (stdio)。 提供 tool:

- `delegation_list_templates` — 一覧 (call_name / title / description / input_schema)
- `delegation_invoke` — `{ call_name, args, cwd?, triggered_by? }` で resolve + spawn、 結果を返す

Concordia loopback (デフォルト http://127.0.0.1:17330) に対して HTTP fetch。
Bearer token は `process.env.CONCORDIA_SPAWN_TOKEN` から取得。

## 7. CLI skill

`Ars/.claude/skills/codex-delegate/SKILL.md`:

```
/codex-delegate <call_name> [key=value ...]

  - .spawn.token を読み、 POST /v1/delegation/invoke
  - 返ってきた prompt_file_path / spawn_pid を出力
  - 失敗時はエラーを返す
```

`Ars/.claude/skills/delegation-templates/SKILL.md` (session-start 提案 skill):

```
- セッション開始時に GET /v1/delegation/templates を取得
- "今回の作業はテンプレで委託しますか?" とユーザに尋ねる用のリスト表示
```

両 skill は Lictor が両 provider に自動 inject する (~/.claude/skills/ と
~/.agents/skills/ の両方に reach する仕組み既存)。

## 8. Web GUI

`web/src/pages/Delegation.tsx` を追加。 NAV に `/delegation` を加える:

- Templates list (active toggle, edit, delete) — provider / model 列を表示
- Create/Edit form (call_name / title / description / target_provider / model /
  prompt_template (textarea) / input_schema (JSON editor) / default_cwd)
- Recent runs (call_name / status / triggered_by / spawn_pid / created_at)
- Input は `.foundation-form` スタイルを使う

### 8.1 Monitor からの spawn (テンプレ起動)

`web/src/pages/Monitor.tsx` の「新規セッション」フォームは provider 直接選択を廃し、
delegation テンプレ選択ベースで起動する:

- テンプレを選ぶと provider / model / 既定 cwd をそのテンプレから採用。
- 「プロンプトを注入」 ON で、 テンプレを render したプロンプトを起動直後に自動注入
  (= delegation invoke 相当)。 注入時のみ input_schema の引数欄を表示。 OFF なら
  provider + model だけの素のセッション。
- backend は `POST /v1/admin/spawn-session` に `template` (call_name) / `inject_prompt` /
  `args` / `cwd?` を受ける。 loopback 信頼境界に乗るため bearer token 不要
  (他 `/v1/admin/*` と同様)。 `inject_prompt=true` の実体は delegation invoke に委譲。

## 9. 初期 seed (3 テンプレ)

| call_name | target | 用途 |
|-----------|--------|------|
| `impl-from-design` | codex | 設計書 path を渡して実装させる |
| `fix-bug` | codex | バグ説明 + 任意の再現手順から修正 PR を作らせる |
| `refactor` | codex | 範囲指定リファクタ (behavior 維持) |

prompt_template は LUDIARS の規約 (feat ブランチ + PR、 vitest、 1 PR 集約 等)
を含める。

## 10. v0.1 で やらないこと

- Lictor / Codex CLI 側の prompt auto-inject (next PR)
- リアルタイム status push (現在は spawn 後の状態追跡なし)
- テンプレ version 履歴
- 同時実行制限 / queue
- Cernere 認証 (spawn token を流用)

## 11. テスト

- repo: CRUD, list, soft-delete
- service: render (default / required / missing var エラー)
- API: 各 endpoint の happy path + 401 (POST 系)
- invoke: spawn を mock した上で delegation_run が記録されること

## 12. v0.2 追加 (persona 注入 / model catalog / spawn 連携 / 報告ファースト)

2026-06-04 に以下を追加。

### 12.1 初期プロンプトへの Concordia 文脈 + persona 注入

`DelegationService.invoke` は prompt file を書く際、 render 済みプロンプトの前に
**Concordia 協調コンテキスト + 暫定 persona 全文** を差し込む
(`src/delegation/persona-context.ts: buildDelegationContext`)。

- persona は `PersonasRepo.pickForDelegation()` が seed 人格から 1 つ選ぶ
  (assignment はしない — DB は変更しない)。 spawn された新セッションは登録時に
  別途 `assign()` で persona を貰うので、 ここで載せるのは「起動直後から人格と
  協調作法が効く」ための暫定値。
- context ブロックには「起動後の振る舞い (報告ファースト)」指示を含む
  → §12.4。
- prompt file の metadata に `- persona: <name>` 行が増える。

### 12.2 model catalog (選択可能モデルの手動管理)

delegation テンプレ / spawn の `--model` 候補を DB で持ち、 Web UI から CRUD する。

- table: `model_catalog(id, model_id, label, provider, sort_order, is_active, …)`
  — `UNIQUE(provider, model_id)`。 `provider='any'` は全 provider 共通候補。
- repo: `src/db/model-catalog-repo.ts` (create/upsert/update/remove/find/list)。
- API: `/v1/model-catalog` GET(`?all=1` で inactive 含む) / POST / PATCH / DELETE
  (loopback 信頼境界、 token 不要)。
- seed: boot 時に空表のときだけ初期モデルを投入 (`src/model-catalog/seed.ts`)。
- Web: Delegation テンプレ編集の model 欄を**プルダウン化** (provider 一致 + any
  を sort_order 順に表示、 既存の未登録モデルは「(未登録)」として末尾保持)。
  追加/編集/削除は **Settings ページのモデルカタログ section**。

### 12.3 spawn からのテンプレ起動

`/v1/admin/spawn-session` は `template` (call_name) でテンプレ起動でき、
`inject_prompt=true` で delegation invoke 本体に委譲する (既存)。 v0.2 で
**Discord `/spawn`** にも `template` (autocomplete) + `inject` option を追加。
template 指定時は token 不要の `/v1/admin/spawn-session` を叩く。

### 12.4 報告ファースト + 受領リアクション

- Discord session channel への通常発言 (= inject) が成功したら、 bot が**その
  メッセージに 👀 リアクション**を付けて受領を可視化する (`discord/ingress.ts`)。
- セッション AI 側は、 起動直後や挨拶/指示受領の直後に「これから何をするか」を
  1〜3 行で宣言してから着手する (報告ファースト)。 指示は `concordia` skill と
  delegation context ブロックの両方に入れる。
