---
type: feature
title: "タスクワークフロー — 分解 → 委託実装 → 安定ブランチテスト → 自走"
description: "実装タスクの一貫パイプライン設計。タスクは md ローカル正本 + Memoria/Actio 登録、Delegation はプロジェクトルート起動 + メモリリンク、実装は新規 worktree、動作テストは安定ブランチの confirm キューのみ (wt テスト絶対禁止・決定論ハーネスで強制)。実装完了検知と残作業チェックは成長型ブラックボックス (機械 seed + LLM フォールバック)、強推論モデルの直接実装はハーネスでブロックして確認する。"
service: concordia
domain: governance
tags:
  - delegation
  - harness
  - blackbox
  - testing
  - memoria
  - lifecycle
  - injection
  - discord
  - queue
status: planned
related:
  - feature/delegation.md
  - feature/delegation-coordination.md
  - feature/develop-confirm-flow.md
  - feature/goal-and-go.md
  - feature/testing-traffic.md
  - feature/cc-workflow.md
  - feature/discord-forum-migration.md
  - feature/subsidiary-delegation.md
updated: 2026-07-13
---

# タスクワークフロー — 分解 → 委託実装 → 安定ブランチテスト → 自走

> 実装タスクを「分解 → Delegation 実装 → テスト → 残作業 → 次タスク」の一本のパイプラインに
> 載せ、 テストの隔離と自走の判断責務を Concordia に集約する。 2026-07-13 neco 指示の設計正本。
> 実装計画書 (GPT 委託用) は `E:\Document\Ars\concordia_task_workflow_impl_plan_gpt.md`。

## 0. 原則 (この 5 つに反する実装はしない)

1. **実装はタスクワークフロー (delegation) に流す。** Fable / Sol-Ultra 等の強推論モデルの
   対話セッションが直接実装に入るときは、 ハーネスがブロックして人間に確認する (§8)。
2. **実装は新規 worktree、 動作テストは安定ブランチ (develop / main) のみ。**
   worktree での動作テストは**絶対禁止** (§4)。
3. **テスト実施の判断・キュー投入・事前通知は Cc の決定論システムが行う。 LLM に判断させない** (§5)。
   LLM の責務は「実装完了を Cc に通知する」まで。
4. **意味判断 (実装完了の検知・残作業の有無) は成長型ブラックボックス** (`@ludiars/blackbox` =
   決定論 seed rule + LLM フォールバック + ルール昇格 + ok/ng 学習) に寄せる (§6, §7)。
   Cc 本体は LLM を内包しない (goal-and-go と同じ思想)。
5. **タスクの正本は md ローカルファイル。** Memoria / Actio は登録先であって正本ではない。
   サービスが死んでいても md だけでワークフローは止まらない (§2)。

## 1. 全体フロー

```
[分解]   セッション LLM がタスクを md に分解保存 ──→ Cc watcher が Memoria/Actio へ登録 (§2)
            │ (md が無ければ分解プロンプトを inject / タスク自体が無ければユーザへメンション)
[委託]   Cc delegation invoke (実行キュー経由・プロジェクトルート起動・メモリリンク添付) (§3)
[実装]   子セッションが新規 worktree を作って実装 → PR (動作テスト・サービス起動は不可 = ハーネス deny) (§4)
[完了]   子: POST /v1/delegation/runs/:id/status {completed}   ← LLM の責務はここまで
         対話セッションの「実装までやってしまった」は completion 黒箱が検知 (§6)
[ゴール] Cc が決定論でゴール判断 (PR merged?) / 判断できなければ人間 (§5)
[テスト] ゴール到達 → confirm キューへ機械投入 + ユーザへ事前通知 (メンション)。
         実施は人間の /confirm start (develop-confirm-flow 既存) (§5)
[残作業] residual 黒箱が残作業をチェック → 次タスクがあれば goal-and-go 経路で inject して自走。
         無ければユーザへメンションで判断を仰ぐ (§7)
```

### 1.1 作業ブランチ規約 — 対話セッションも同じ流路に載せる (2026-07-17 neco 指示)

delegation の子セッションに限らず、 **対話セッションが自ら実装する場合も**
以下の一本の流路に従う。 例外は作らない。

```
セッション起動 → 作業内容解析 → 作業ブランチ確定 → ワークツリー生成
  → 作業 → 作業完了 → タスクワークフローに積む (§2 の task md が正本)
  → コミット → PR 作成まで行う
```

- **main / develop の直編集・直コミットで実装しない。** 作業ブランチを確定して
  からワークツリーを生成し、 その中で作業する (worktree-hygiene 準拠)。
- ルートフォルダ (リポ本体) のブランチ切り替え自体はハーネスの判定対象にしない (不問)。 判定するのは main/develop への直コミットと、 完了フロー (task md → コミット → PR) の欠落である。
- 作業の実行手段として**タスクワークフロー (delegation) を使ってもよい**。
  使わない場合も task md 分解 (§2) とブランチ規約は同じ。
- Session は PR 作成で停止する。レビュー・テスト・CI 継続は、ユーザが当該 Session に
  明示した場合だけ行う。
- **オートマージ禁止 (このフローの絶対則)。** `gh pr merge --auto` や GitHub の
  auto-merge 有効化を含む、 人間の明示操作を介さないマージを行わない。
  マージは人間の明示操作、 または confirm フロー (§5) を経た明示マージのみ。
  ハーネス builtin ルール (`src/subsidiary/harness-seed.ts`) で deny する。

## 2. タスク管理 — md 正本 + Memoria / Actio 登録

### 2.1 md 正本

- 置き場: **対象プロジェクトのリポ内** `<repo>/spec/tasks/<YYYY-MM-DD>-<slug>.md`
  (2026-07-13 neco 確定。 ワークスペース共有ディレクトリではなく各リポの spec 配下に持つ —
  タスクが設計と同じ場所で版管理され、 PR にも載る)。
- Cc 側の走査は既存のリポ列挙 (`src/work/repo-scan.ts`) を再利用して各リポの `spec/tasks/` を見る。
  専用 config (`tasks.dir`) は**持たない**。
- spec ツーリング (Concordia の `tools/build-spec-index.mjs` 等、 OKF frontmatter を集約するもの) は
  `spec/tasks/` を**走査対象から除外**する (task md の frontmatter は OKF ではないため)。
- 分解の単位・粒度は **LLM (セッション) 任せ** (現状の自然な分解を踏襲)。
  セッションは設計やユーザ依頼をこの md に書き出してから作業に入る。
- frontmatter (OKF 同様に YAML):

```yaml
---
task: fix-auth-refresh            # slug (ファイル名と一致)
project: Cernere                  # リポ名 (leaf)。置き場のリポと一致すること (検証用の冗長フィールド)
kind: 実装                        # 設計相談 | 実装 | レビュー | テスト | 雑用 (forum タグと同語彙)
created: 2026-07-13
memory_links: []                  # 参照メモリ (ファイルパス / URL)。委託時に §3.2 でそのまま渡す
---
# タイトル
## 目的
## 完了条件
## スコープ (編集可ディレクトリ)
```

### 2.2 登録 (reconcile)

- Cc の **task-md reconciler** (定期 tick) が全リポの `spec/tasks/` を走査し、
  SQLite の `taskflow_task_state` にある `status=pending` かつ `memoria_task_id IS NULL` の task を Memoria へ登録する
  (`src/memoria/client.ts` の `createTask` 既存経路)。登録 claim と ID は同じ state 行へ永続化し、Markdown は**一切書き戻さない**。
- `status`、外部 task ID、`source_session`、`assignee` / `owner`、`delegation_run_id`、`pr_number` はすべて runtime state である。
  旧 frontmatter に残ったこれらの値は初回読込時だけ state へ移行し、既存 Markdown のバイト列は変更しない。
- Memoria 登録の開始 claim も state に永続化する。登録結果が不明な通信失敗では claim を保持して再 POST せず、
  同じ task の重複作成を防ぐ。
- Memoria が落ちていても md は正本としてそのまま使える。 復帰後の tick で後追い登録される
  (= 「サービスが死んでいるときも動作」の実現)。
- backend は interface (`TaskBackend`) で抽象化する。 今回は Memoria 実装のみ。
  **Actio adapter は Phase 4** (stub や no-op は作らない — RULE_CODE §7.1)。

### 2.3 md 未出力 / タスク無しの扱い

- 実装完了イベント (§5, §6) の時点で当該セッション/プロジェクトに対応する task md が無い場合、
  Cc は**分解プロンプトを inject** する (「作業内容を §2.1 形式で `<repo>/spec/tasks/` に分解保存せよ」)。
- 分解の結果「タスクが無い」(残作業なし・依頼が空) と分かったら、
  **ユーザへメンション付きで判断を仰ぐ** (§10)。 Cc が勝手にタスクを発明しない。

## 3. Delegation 起動規約 — プロジェクトルート + メモリリンク

### 3.1 起動 cwd はプロジェクトルート

- 実装タスクの delegation は **対象リポのルート** (`default_cwd: ${target_repo}`) で起動する。
  Cc 側の invoke `worktree` オプションは実装テンプレでは**使わない** —
  worktree の作成・破棄は**子セッション自身**が worktree-hygiene に沿って行う。
- 理由: ルート起動で CLAUDE.md・プロジェクト文脈・スキルを正しくロードさせ、
  wt のライフサイクル (最新化・作り捨て) を作業主体に持たせる。
- 既存の実行キュー (delegation-coordination §6: 上限・FIFO・副作用遅延) にそのまま載る。

### 3.2 追加メモリは外部リンクで渡す

- invoke に `memory_links: string[]` を追加 (task md の `memory_links` を透過)。
- render 済みプロンプトに「参照メモリ」節としてパス / URL を**列挙するだけ**にする
  (内容を inline しない — コンテキスト節約 + 正本参照の原則)。 子が必要な分だけ読む。

### 3.3 persona-context への追記 (子への指示)

`src/delegation/persona-context.ts` に以下を追加する (既存の「完了時 status 報告」「報告ファースト」と併記):

1. 起動したら **最新の origin base から新規 worktree を作成**して実装する
   (base = リポに `origin/develop` があれば develop、無ければ main)。 PR base も同じ。
2. **ユーザが明示していないテストを実行しない。** 単体・統合・動作・起動を問わない。
3. 実装が終わったら commit + push + PR + `POST /v1/delegation/runs/:id/status {completed}` まで。
   **テスト・マージ・確認はスコープ外** (Cc と人間が行う)。

## 4. テスト隔離 — 決定論ハーネス (LLM 判断なし)

テスト種別にかかわらず Session からの自動実行は禁止。ユーザが明示した起動テストだけは
Excubitor + testing claim の隔離規約を適用する。

### 4.1 新設する決定論述語 (A 層、 `src/harness/`)

predicates.ts の思想を踏襲する: 純関数、 判定不能なら null (偽陽性で止めない)、
判定できる場面は fail-closed。

| rule | decision | 内容 |
|---|---|---|
| `no-op-test-in-worktree` | **deny** | cwd が linked worktree (`isWorktree`) で、 サービス起動・動作テスト系コマンド (start-*.bat / `npm run dev` / `npm start` / `node dist/` / integration・e2e スクリプト等) を実行しようとした |
| `no-service-start-in-session` | **deny** | セッション内でのサービス起動コマンド (worktree 外でも)。 起動は Excubitor / confirm フロー経由のみ (HARNESS.md §4 の機械化) |

- `HarnessAction` に `isWorktree?: boolean` を追加。 判定は hook (resolver) 側で
  `git rev-parse --git-dir` と `--git-common-dir` の相違により解決して渡す。 不明なら省略 = 強制しない。
- 決定論で区別できない動作テスト (curl での手動確認等) は B 層 (自然文 `harness_rules` /
  gate 黒箱) と HARNESS.md の運用ルールでカバーする。 二層で「絶対禁止」を支える。

### 4.2 HARNESS.md (AIFormat) とハーネスルールへの追記

**AIFormat `HARNESS.md` §4 に追記する規範文言** (別リポ PR):

> セッション内で動作テストをしない。 動作テストは Concordia の confirm キュー
> (develop / main の安定クローン、 Excubitor 経由起動) でのみ行う。
> **worktree での動作テストは絶対禁止。** 実装セッションの責務は
> 「実装 → PR → 完了 status 報告」まで。
>
> タスクは着手前に **対象リポの `spec/tasks/` に md で分解保存**してから作業する
> (形式は Concordia spec/feature/task-workflow.md §2.1)。 保存した md は Concordia が
> Memoria / Actio へ登録する — サービスが落ちていても md が正本なので作業は止めない。

**Cc ハーネス側** にも同旨を持つ:

- 決定論 (A 層): §4.1 の述語 + §2.3 の分解 inject (md 未出力の機械検知) が強制面。
- 自然文 (B 層): `harness_rules` の既定 seed に
  「実装タスクは着手前に対象リポ `spec/tasks/` へ md 分解保存する」
  「セッション内・worktree での動作テストは禁止 (confirm キューのみ)」を追加する
  (subsidiary ガード / gate 黒箱の判断根拠に載せる)。

## 5. ゴール判断とテストキューイング (決定論 + 人間)

LLM はゴール判断をしない。 判断材料は **PR の状態** (決定論) と人間。

- 子の `POST /runs/:id/status {completed}` 受信時 (既存 API)、 Cc は run に紐づく PR を見る:
  - **PR が base へ merged 済** → ゴール到達。 confirm キュー (`confirm_runs`) へ投入
    (develop merge は既存の PR reconciler 検知と同一行に冪等合流)。
  - **PR open** → cc-workflow の CI 追従に任せ、 merge 検知で上記に合流。
  - **PR 無し** → ゴール未到達。 親セッションへ通知し、 **ユーザへメンション**で
    「PR 化するか / このまま閉じるか」の判断を仰ぐ (機械では決めない)。
- **テストキュー投入時の事前通知**: `confirm_runs` 作成時に Discord へ**ユーザメンション付き**で
  「確認テストがキューに入った。 `/confirm start <svc>` で開始」を通知する
  (= 要件「キューイングはユーザ確認を伴うため事前に通知が飛ぶ」)。
- テストの**実施**は必ず人間の `/confirm start` (develop-confirm-flow 既存。 自動起動しない)。

## 6. 実装完了検知 — completion 黒箱 (対話セッションの捕捉)

対話セッションが「実装までやってしまった」ケースを検知してテストキューに繋ぐ。
delegation run は §5 の status API が正なので、 本節は **status を返さない対話セッション**が対象。

- 新 blackbox domain **`concordia.workflow.completion`** (`HarnessBlackboxService` と同型の
  seed → LLM フォールバック → 昇格 → recordVerdict 学習)。
- 決定論 features: `final_answer` / `summary` イベント、 セッションに紐づく PR 状態、
  直近 push / commit の有無、 report bullets。
- seed rule (決定論):
  - セッション由来 PR が base へ merged → **completed**。
  - push も diff も無い → **not-implementation** (誤発火防止)。
- 未知ケースのみ LLM フォールバック (黒箱内 Haiku) が最終回答文面から「実装完了か」を分類。
- completed 判定後は **§5 と同じ機械経路**に合流する (merged → confirm キュー + 事前通知 /
  PR 無し → PR 化を inject or メンション)。

## 7. 残作業チェックと自走 — residual 黒箱 + goal-and-go

- 新 blackbox domain **`concordia.workflow.residual`**。 発火契機は完了イベント (§5 / §6) の後。
- 決定論 features / seed: 未コミット diff の有無、 open PR の CI 状態 (red)、
  対象リポ `spec/tasks/` の `pending` タスク、 Memoria pending タスク。
- 未知ケースのみ LLM フォールバックが残作業の有無を判定する (機械的 + LLM 判断のハイブリッド)。
- 出力の接続:
  - **次タスクあり** → 当該セッションへ **goal-and-go の inject 経路**で次タスクを渡して自走させる
    (opt-in・回数/時間上限・ask 待ち除外は goal-and-go の安全機構をそのまま共有)。
  - **task md が無い** → §2.3 の分解 inject。
  - **タスクが本当に無い** → ユーザへメンションで判断を仰ぐ (§10)。

## 8. 強推論モデルの実装ゲート

- 新述語 `strong-model-impl` (**deny**): セッションのモデルが強推論リスト
  (AdminState `harness.strong_impl_models`、 既定 `["fable", "sol-ultra"]`、 部分一致) にあり、
  編集ツールで**コードファイル** (.md / spec / docs を除く) を編集しようとした。
- deny 時の suggestion: 「実装はタスクワークフロー (delegation) へ委託する。
  このセッションで続けるならユーザ承認で解除」。 同時に**ユーザへメンション**で確認を飛ばす。
- 解除は人間のみ: Discord `/harness unlock-impl <session>` (または WebUI / API
  `POST /v1/sessions/:id/impl-unlock`)。 解除はセッション metadata に焼き、 以後そのセッションは allow。
- `HarnessAction` に `sessionModel?: string` を追加 (gate ハンドラが session 登録情報から解決)。
- 意図: 強推論モデルは設計・レビューに温存し、 実装は §9 の強度自動調整に乗った delegation へ流す。

## 9. 実装 LLM の推論強度自動調整 (既存 + 差分)

- **既存で充足**: 役割別テンプレ (調査=Sonnet / 実装=Codex / 高度=Fable)、
  invoke `overrides.reasoning_effort` (codex `-c model_reasoning_effort=` 透過)、
  local レーンの Cc管理既定モデル (model="auto")。
- **実装済み**: Codex / Claude の model/effort は Session Spawn とtask変更時にGeniusを照会する。
  score閾値以上のhit時だけCcの小型judgeが候補を作り、Discord確認後に適用する。miss時は
  Discordへ記録して現在値を維持し、別LLMへの自動フォールバックは行わない。

## 10. メンション方針

- egress 既定の `AllowedMentions parse:[]` は維持する。
- 例外として「**ユーザの判断が必要**」なイベントのみ、 設定ユーザ (AdminState
  `admin.mention_user_id`) への明示メンションを許可する:
  確認テストのキュー投入 (§5) / タスクが無い (§2.3, §7) / PR 化の判断 (§5) /
  強推論モデル実装の承認 (§8) / セッションからの質問。
- Discord フォーラム移行後は投稿先を当該 run の TaskWorkflow スレッド (1 run = 1 スレッド) に寄せる。
- Discord 投稿は `<@id>` の文字列だけでなく `allowedMentions.users=[id]` を明示し、
  設定済みユーザだけを実際に ping する。

### 10.1 自走完了時の session-end

goal-and-go が有効で、PR が open/draft のテスト候補として引き継がれ、residual 判定が
`none` の場合は provider 別の session-end (`/session-end` / `$session-end`) を自動 inject
する。同じ session の `auto:session-end` inject は永続イベントを使って exactly-once にする。
次タスク・分解・confirm queue・PR 判断など自走または人間の作業が残る場合は自動終了しない。

## 11. Discord フォーラム移行との整合

- task md の `kind` はフォーラムの作業内容タグ (固定 5 種:
  `設計相談/実装/レビュー/テスト/雑用`) と**同語彙**にする (discord-forum-migration §決定)。
- TaskWorkflow フォーラムの 1 run = 1 スレッドが本パイプラインの可視面になる。
  本設計は forum 移行 Phase 1 (別ブランチ実装中) と独立に実装でき、 移行後は通知投稿先だけが変わる。

## 12. データ / API 差分まとめ

| 種別 | 差分 |
|---|---|
| config | 追加なし (task md は各リポ `spec/tasks/`。 走査は既存 `src/work/repo-scan.ts` を再利用) |
| AdminState | `harness.strong_impl_models` / `admin.mention_user_id` |
| harness_rules seed | 「着手前に `spec/tasks/` へ md 分解保存」「動作テストは confirm キューのみ」(§4.2) |
| API | `POST /v1/sessions/:id/impl-unlock`、 `GET /v1/taskflow/tasks` (md 一覧の read-only)、 `GET /v1/taskflow/overview` (担当・状態・PR・CI の統合一覧)、 invoke `memory_links` |
| DB | `taskflow_task_state` に task の mutable runtime state を保持する。task md は static definition のみ。 |
| events | `taskflow.completion_detected` / `taskflow.residual_checked` (監査用) |
| blackbox | domain `concordia.workflow.completion` / `concordia.workflow.residual` |
| module | 新設 `src/taskflow/` (md-store / reconcile / backend / decompose-inject / completion / residual / goal-machine)。 既存 `workflow-worker` (delegation キュー消費) とは別物 |

`overview` は task md の static definition と SQLite runtime state を結合し、`assignee` / `owner` /
`source_session` / `delegation_run_id` / `pr_number` は runtime state の明示値として扱う。未指定値は sessions、delegation_runs、
pr_records から補完し、CI は GitHub reconcile 済みの `pr_records.ci_status` を表示する。

## 13. 実装フェーズ

| Phase | 内容 | PR |
|---|---|---|
| 1 | ハーネス隔離: 述語 2 種 (§4.1) + 強推論ゲート (§8) + persona-context 追記 (§3.3) + invoke `memory_links` (§3.2) | Cc 1 PR + AIFormat 1 PR (HARNESS.md §4.2) |
| 2 | タスク md 基盤: md-store / reconciler / TaskBackend(Memoria) / 分解 inject / メンション経路 / harness_rules seed 追記 (§2, §4.2, §10) | Cc 1 PR |
| 3 | 黒箱 + キュー接続: completion / residual domain + ゴール機械判断 + confirm 事前通知 + goal-and-go 接続 (§5-§7) | Cc 1 PR |
| 4 | Actio adapter (§2.2)。effort blackbox (§9) は Cc 側で実装済み | Actio は別途 / effort は Cc 1 PR |

## 14. 受け入れ基準

- [ ] worktree 内でのサービス起動・動作テスト系コマンドが deny され、 監査ログに残る。
- [ ] 強推論モデルのセッションがコード編集に入ると deny + ユーザメンションが飛び、 unlock 後は通る。
- [ ] 実装 delegation がプロジェクトルートで起動し、 プロンプトに memory_links が列挙される。
- [ ] リポの `spec/tasks/` に task md を置くと reconciler が Memoria に登録し、ID と登録 claim を SQLite state に永続化する。Memoria 停止中でも md 運用が継続し、復帰後に後追い登録される。
- [ ] 子の completed 報告で、 merged PR なら confirm_runs が立ちメンション付き事前通知が飛ぶ。 PR 無しならユーザ判断のメンションが飛ぶ。
- [ ] 対話セッションの実装完了を completion 黒箱が検知し、 §5 と同じ経路に合流する。
- [ ] 完了後に residual 黒箱が走り、次タスクがあれば goal-and-go 経路で同セッションに
  inject される。真の自走完了なら provider-aware session-end を exactly-once で inject し、
  goal-and-go 無効時や人間判断が残る場合だけメンションで停止する。
- [ ] テストの実施開始は常に人間の `/confirm start` であり、 Cc が自動で起動しない。
