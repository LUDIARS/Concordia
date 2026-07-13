---
type: feature
title: "Delegation Templates — 設計"
description: "AI エージェント間の作業委託フレームワーク。Claude / Codex / Gemini / gemma4-12 (ローカル LLM) をテンプレート呼び出し名で発火し、Concordia が resolve + spawn + 履歴記録を管理する。v0.1 の spawn + render から v0.3 の Famulus 連携・model=\"auto\" 黒箱選択まで実装済み。"
service: concordia
domain: governance
tags:
  - delegation
  - llm
  - spawn
  - claude
  - codex
  - sqlite
  - rest-api
  - lifecycle
status: implemented
updated: 2026-06-30
---


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
  target_provider ("claude" | "codex" | "gemini" | "gemma4-12")  -- gemma4-12=ローカル LLM レーン (§13、 旧名 gamma)
  model (NULLABLE TEXT — spawn する CLI に `--model` で渡す。 null = provider CLI の config 既定 / gemma4-12 は gemma4:12b)
  prompt_template (TEXT、 ${var} placeholder)
  input_schema (JSON 配列: [{name, type, required, description, default?}])
  default_cwd (NULLABLE TEXT)
  project (NULLABLE TEXT)  -- 対象プロジェクト名 (cwd と別。 famulus auto-model のヒント等)
  is_active (INTEGER 0/1)
  category (TEXT NOT NULL DEFAULT 'employee')  -- 雇用形態カテゴリ (§2.1)
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

### 2.1 category (雇用形態カテゴリ)

delegation を「どう起動されるか」で 3 分類する。 単一情報源は
`src/db/delegation-repo.ts` の `DELEGATION_CATEGORIES` (zod / UI / portable が参照)。

| 値 | 表示名 | 意味 | 例 |
|----|--------|------|-----|
| `employee` | 従業員 | セッションワーカー。 spawn で対話セッションとして起動する汎用実装レーン | `claude-*-impl`, `codex-5-6-*`, `task-process` |
| `freelancer` | フリーランサー | caller (`delegation_invoke` / call_only) で呼び出す特化型指示タスク | `impl-from-design`, `design-hard-fable5`, `review-sonnet5` |
| `parttimer` | パートタイマー | スケジューラ (cron / morning) が時限起動するタスク | `morning-tasks`, `ludiars-review-daily`, `daily-review-reconciliation` |

- 既定は `employee` (既存 DB の行は列追加 migration で employee に埋まる。 seed テンプレは boot upsert で正しい値に上書き)。
- `GET /v1/delegation/templates?category=<値>` で絞り込み可 (不正値は 400)。
- category は表示・分類のためのメタデータで、 spawn 経路の挙動は変えない
  (spawn 可否の制御は従来どおり `call_only`)。

## 3. テンプレ render

- `${var_name}` を args[var_name] で置換
- `${var_name:default}` で default
- args に required な変数が無ければエラー
- input_schema の `type` は `"string" | "number" | "boolean"` のみサポート (v0.1)
- 入力検証で zod を使う

## 4. invoke flow (v0.1)

1. POST /v1/delegation/invoke `{ call_name, args, cwd?, extra_prompt?, triggered_by?, spawn? }`
2. テンプレ resolve → input_schema validate → render
   - `extra_prompt` (任意) があれば render 結果の末尾に「## 追加の初回指示（人間）」として
     追記する。テンプレ render とは別経路で、起動時に人間が渡す追加指示(全テンプレ共通)。
     prompt file・`run.rendered_prompt`・response の `rendered_prompt` すべてに載る。
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
| GET    | /v1/delegation/templates/:identifier/export | none | 1 件を可搬 JSON で書き出す (コピー) |
| POST   | /v1/delegation/templates/import | none | 可搬 JSON を貼付して新規作成 (call_name 自動採番) |
| POST   | /v1/delegation/templates | none | 新規作成 |
| PATCH  | /v1/delegation/templates/:id | none | 更新 |
| DELETE | /v1/delegation/templates/:id | none | soft delete (is_active=0) |
| POST   | /v1/delegation/invoke | none | テンプレ resolve + spawn |
| GET    | /v1/delegation/runs | none | 直近 100 件 |

mutating endpoint も bearer token を要求しない。 Concordia は loopback
(既定 127.0.0.1:11111) 限定で動き、 `/v1/admin/*` と同じ信頼境界に乗る。
以前は `.spawn.token` を要求していたが、 同じ loopback サービスで Monitor の
spawn は token-free・Delegation CRUD だけ token 必須という非対称が混乱の元
(token 未貼付で Save できない) だったため撤廃。

## 6. MCP server

`src/mcp/delegation-server.ts` (stdio)。 提供 tool:

- `delegation_list_templates` — 一覧 (call_name / title / description / input_schema)
- `delegation_invoke` — `{ call_name, args, cwd?, triggered_by? }` で resolve + spawn、 結果を返す

Concordia loopback (デフォルト http://127.0.0.1:11111) に対して HTTP fetch。
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

## 9. 初期 seed

| call_name | target | model | 用途 |
|-----------|--------|-------|------|
| `impl-from-design` | codex | — | 設計書 path を渡して実装させる |
| `fix-bug` | codex | — | バグ説明 + 任意の再現手順から修正 PR を作らせる |
| `refactor` | codex | — | 範囲指定リファクタ (behavior 維持) |
| `claude-opus-4-8-impl` | claude | claude-opus-4-8 | Claude Opus に実装委託 (最上位 / 難所・設計判断向き) |
| `claude-sonnet-5-impl` | claude | claude-sonnet-5 | Claude Sonnet に実装委託 (中位 / 一般実装の主力) |
| `claude-fable-5-impl` | claude | claude-fable-5 | Claude Fable に実装委託 (高速 / 軽量〜中規模) |
| `gemma4-12-impl` | gemma4-12 | auto | ローカル LLM (Famulus 経由) に実装委託、 API 課金ゼロ |

`target_provider=claude` のテンプレは spawn 時に `lictor claude --model <id>` で起動する
(`resolveDelegationSpawn`)。 prompt_template は LUDIARS の規約 (feat ブランチ + PR、 vitest、
1 PR 集約 等) を含める。 旧 `gamma-impl` (target=gamma) は seed 時に deactivate される。

時限起動 (parttimer) の seed には `daily-review-reconciliation` (毎朝 5:10 JST、
cron-jobs.ts) がある。 Codex × Claude Opus の独立差分レビュー + 突合。 対象は
`LUDIARS/service-map.json` の Tier 1、 プロンプト正本は `LUDIARS/docs/REVIEW-PROMPTS.md`
(テンプレ側に本文を二重管理しない)。 旧 `ludiars-review-daily` (5:07) は新方式の安定確認
まで並走し、 その後停止する (LUDIARS/docs/REVIEW-STRATEGY.md §7 O2)。

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
  メッセージに ✅ リアクション**を付けて受領を可視化する (`discord/ingress.ts`)。
- セッション AI 側は、 起動直後や挨拶/指示受領の直後に「これから何をするか」を
  1〜3 行で宣言してから着手する (報告ファースト)。 指示は `concordia` skill と
  delegation context ブロックの両方に入れる。

### 12.5 テンプレ作成の空欄許容

`POST /v1/delegation/templates` は `call_name` / `title` / `prompt_template` を
空欄でも 201 で受け付ける (下書き保存)。

- `call_name` 空/不正 → `title` をスラッグ化、 無理なら `tpl-<random>` を自動採番。
  既存と衝突したら `-2`, `-3`, … で一意化する。
- `title` 空 → `call_name` で代替。
- `prompt_template` 空 → 空文字のまま保存 (invoke 時は Concordia 文脈 + persona
  ブロックだけが載る)。

## 13. v0.3 追加: `gemma4-12` プリセット (ローカル LLM 委託レーン)

API 課金ゼロでローカル LLM に委託するための **論理 provider プリセット**。

> **改名 (旧名 `gamma`)**: Lictor のローカル LLM 起動コマンドを `lictor gemma4-12`
> に揃えたのに合わせ、 本プリセットも `gamma` → `gemma4-12` にリネームした。
> `resolveDelegationSpawn` は DB に永続化済みの旧値 `gamma` も後方互換で受理する。
> 旧 seed テンプレ `gamma-impl` は seed 時に deactivate される。

### 13.1 なぜ「論理プリセット」か

`target_provider` を **論理プリセット**とし、 実 spawn (CLI + args + env) への解決を分離する。
gemma4-12 は Lictor のネイティブ local-agent (`lictor gemma4-12` = Ollama を直接叩く軽量
REPL) を起動する。 **codex CLI は経由しない** (旧 v0.3 は codex の OSS モード
`codex --oss --local-provider ollama` を使っていたが、 Lictor にネイティブ local provider が
出来たので廃止した)。 推論は Ollama 上のローカルモデル (既定 Gemma 4 12B)。

| 論理 provider | 実 spawn (`lictor <provider>`) | 付与 args / env | 推論 |
|---|---|---|---|
| claude | claude | `--model <model?>` | Claude |
| codex | codex | `--model <model?>` | OpenAI Codex |
| gemini | gemini | `--model <model?>` | Gemini |
| **gemma4-12** | **gemma4-12** (Lictor local-agent) | env `LICTOR_LOCAL_MODEL=<model\|gemma4:12b>` | **ローカル (Gemma 等)** |

- 解決の単一情報源は `src/control/provider-preset.ts` の `resolveDelegationSpawn(target, model)`。
  delegation invoke (`delegation/service.ts`) と admin spawn-from-template (`app.ts`) の
  両経路が同じ写像を使う。 旧値 `gamma` も後方互換で受理する。
- `model` 未指定なら既定 `gemma4:12b`。 別の Ollama タグ (例 `qwen2.5-coder:14b`) を
  使うなら template.model に設定 → `LICTOR_LOCAL_MODEL` env で Lictor へ渡る (CLI フラグ
  ではない)。
- 記録・ログ・プロンプトヘッダ・GUI ドロップダウンは**論理名 `gemma4-12`** で表示する。

### 13.2 前提と既知の制約

- **ホスト要件**: Ollama が `http://localhost:11434` で稼働し、 指定モデルを pull 済み。
  Lictor 側のローカル LLM 設定は `LICTOR_LOCAL_*` env (spec: `Lictor/spec/local-llm-agent.md`)。
- **reasoning モデルはトークン大食い**: Gemma 4 等は思考 (reasoning) でトークンを使う。
  小さいタスクに区切ること。 長い多段エージェントループは精度・速度ともに落ちる。
- **local-agent はチャット主体**: Lictor の local-agent は会話ログ保持の REPL であって、
  claude/codex のような tool-use / ファイル編集 / PR 作成は持たない。 「実装委託して PR を
  作らせる」 用途には向かず、 下書き生成・調査メモ・対話のローカル代行が主用途
  (実装系の委託は claude / codex レーンを使う)。
- **session 表示は local-llm**: Lictor は `lictor gemma4-12` を起動するため、 起動後の
  **ライブ session は Concordia 上 `local-llm` として登録**される (gemma4-12 provider の
  `concordiaProvider`)。

### 13.3 seed テンプレ

`gemma4-12-impl`「ローカル LLM 実装委託 (gemma4-12 / auto)」 を seed に追加 (`delegation/seed.ts`)。
target_provider=`gemma4-12` / **model="auto"** / default_cwd=`${target_repo}`。
旧 seed `gamma-impl` (target_provider=gamma) は seed 時に deactivate される。

### 13.4 Famulus 連携 + model="auto" (黒箱選択)

実 spawn は `lictor gemma4-12` → Lictor が別リポ **Famulus** (`@ludiars/famulus`) の
`famulus run` を pty 起動する (ローカル LLM スポナーを切り出した。Lictor 側の repoint 済)。

`model="auto"` のとき、 delegation invoke (`delegation/service.ts`) と admin
spawn-from-template (`app.ts`) は `resolveLocalModel` (`control/famulus-select.ts`) で
**`famulus select --project <target_repo の basename>` を shell** し、対象プロジェクトに
合うモデルを Famulus の黒箱切り替え機 (FT registry + Sonnet ワンショット) に選ばせる。

- 選択の Sonnet 呼び出しは **Famulus 内部**なので Concordia は LLM-free を維持
  (Famulus CLI を叩くだけ)。
- 黒箱は常に model_id を返す (Sonnet 不可でも決定論フォールバック)。失敗時は既定
  `gemma4:12b`。
- 「全パターンの delegation テンプレを作らない」 → `model="auto"` の 1 本に集約する設計。
- 解決済みモデルは `resolveDelegationSpawn` 経由で `LICTOR_LOCAL_MODEL` env として Famulus
  に渡る。

> 前提: Concordia と同ホストに `famulus` CLI が PATH 解決可能であること (現状 npm link)。
