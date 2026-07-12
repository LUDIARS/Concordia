---
type: feature
title: "Develop confirm flow"
description: "実装完了 → develop へ squash マージ → 確認タスク発行 → ユーザが Discord コマンドで develop 版を起動して確認 → OK なら main へ反映して再起動、までを自動化するリリース動線。"
service: concordia
domain: governance
status: implemented
updated: 2026-07-12
tags:
  - release
  - delegation
  - discord
---

# Develop confirm flow

## 0. 目的

実装が終わったものを **いきなり main に入れない**。 develop に集めてから人間が
1 度だけ動作確認し、 OK なら main に上げる。 確認の呼び出し・起動・切り戻し・
main 反映までを Concordia が自動でやり、 人間は Discord で 2 回コマンドを打つだけにする。

## 1. 全体の流れ

1. **ブランチ**: 全リポで `main` / `develop` を分ける (無いリポは `main` から `develop` を作る)。
2. **クローン**: リポごとに 2 クローン持つ。
   - main 系: `<workspaceRoot>/<Repo>` (従来のまま)
   - develop 系: `<workspaceRoot>/develop/<Repo>`
3. **実装**: 実装 PR の base は **`develop`**。 CI グリーンで **squash オートマージ**。
4. **確認タスク発行**: develop へのマージを検知したら Concordia が
   - Memoria に「確認タスク」を **pending** で積む
   - 自分の中にも確認待ちリスト (`confirm_runs`) を持つ
5. **確認開始** (Discord `/confirm start <service>`):
   - develop クローンを `origin/develop` に同期 → ビルド → **develop 版で起動し直す**
6. **確認完了** (Discord `/confirm ok <service>`):
   - `develop` を `main` に反映 → main クローンを同期 → **main 版で起動し直す** → 確認タスクを done
7. **トラブル時**: **起動できなかった場合のみ** 自動で main に戻す (`/confirm ng` でも手動で戻せる)。
   原因のログ調査・develop の再修正は今回のスコープ外 (人間 / 別セッションが行う)。

## 2. 決定事項 (2026-07-11 neco 確定)

- **対象は全リポ**。
- **develop と main は同時に起動しない** (排他・同ポート)。 確認中は該当サービスの main 版を止める。
- **クローン配置**: 同じワークスペース内。 `<root>/develop/<Repo>` に置く
  (`<Repo>-develop` のような兄弟配置にすると Work / ludiars-review の repo 走査が
  全リポを二重に拾うため。 `develop/` 自体は `.git` を持たないので走査対象外になる)。
- **確認の開始も完了も Discord コマンド** (自動判定しない)。
- **トラブル時の自動対応は「機能追加によるダウン時のみ」** = develop 版が起動しなかった / liveness が
  取れなかった場合に main へ戻すところまで。 ログからの原因調査・自動再修正はやらない。

## 3. 「複製フォルダからの起動禁止」との整合

運用ルールは「再起動・起動テストは Excubitor 経由・プロジェクト本体フォルダのみ
(worktree / 複製フォルダからの起動は禁止)」。 develop クローンからの起動はこれに抵触する。

**例外を作らず、 develop クローンを Excubitor の正規サービスとして登録する**:
- Excubitor catalog に `<code>-develop` を生やす (cwd = develop クローン、 port は main と同一)。
- 同一ポートを持つ 2 エントリだが **同時起動しない** ので衝突しない。 Concordia は必ず
  「片方を stop → もう片方を start」の順で操作する。
- これにより「起動は常に Excubitor 経由・catalog 登録済みサービスのみ」という不変条件は保たれる。

## 4. データモデル

`confirm_runs` — 確認 1 件 (= develop に入った 1 つのマージ)。

| 列 | 説明 |
|---|---|
| `id` | uuid |
| `repo_origin` / `repo_name` | 対象リポ |
| `service_code` | Excubitor のサービスコード (無い = 起動を伴わないリポ) |
| `pr_number` / `pr_title` / `pr_url` | 由来 PR |
| `develop_sha` | マージ後の develop HEAD |
| `status` | `pending` → `confirming` → `confirmed` / `rejected` / `failed` |
| `memoria_task_id` | Memoria に積んだ確認タスク id (null = 連携失敗) |
| `error` | 起動失敗時の理由 |
| `created_at` / `updated_at` |

- 1 サービスに複数の pending が溜まりうる (連続でマージした場合)。 `/confirm start` は
  **そのサービスの pending をまとめて confirming にする** (develop HEAD には全部入っているため)。
- `confirmed` になっても行は消さない (外注履歴と同じく、 何をいつ確認したかの記録)。

## 5. develop マージの検知

既存の PR reconciler (`src/pr/reconcile.ts`, gh CLI ポーリング) を使う。
`pr_records` は既に `base_branch` / `state` / `merged_at` を持つ。

- reconcile が `state: open → merged` かつ `base_branch === "develop"` を観測した時に
  `confirm_runs` を 1 行作る (冪等: `pr_number` + `repo_origin` で重複作成しない)。
- 併せて Memoria に確認タスクを積む (`POST /api/tasks`)。 Concordia backend から Memoria へ
  **書き込む経路は今まで無かった**ので、 `src/memoria/client.ts` を新設する。
- Discord の PR キューチャンネルに「確認待ち」を通知する。

## 6. Discord コマンド `/confirm`

| サブコマンド | 動作 |
|---|---|
| `/confirm list` | 確認待ち (pending) / 確認中 (confirming) の一覧 |
| `/confirm start <service>` | develop 同期 → ビルド → develop 版で起動。 失敗したら main に戻す |
| `/confirm ok <service>` | develop → main 反映 → main 版で起動 → 確認タスクを done |
| `/confirm ng <service>` | 確認中止。 main 版に戻す (confirm_runs は pending に戻す) |

`start` / `ok` / `ng` は必ず `POST /v1/testing/claim` → 作業 → `POST /v1/testing/release` を通す
(他セッションが同じサービスを触っていたら警告 inject が飛ぶ)。

## 7. 起動の手順 (排他切り替え)

`/confirm start <service>`:
1. testing claim
2. `git -C <develop clone> fetch origin && git reset --hard origin/develop`
3. ビルド (`npm ci && npm run build` 等。 サービスの `runtime` に応じて Excubitor の
   `command` を使う。 ビルドコマンドは catalog の `build_command` を見る。 無ければスキップ)
4. Excubitor: `POST /api/v1/services/<code>/control {action:"stop"}` (main 版)
5. Excubitor: `POST /api/v1/services/<code>-develop/control {action:"start"}`
6. liveness 確認 (`GET /api/v1/services/<code>-develop/liveness`)。 **起動できなければ**
   develop を stop → main を start → `confirm_runs.status = failed` + Discord に理由を返す
7. testing release

`/confirm ok <service>`:
1. testing claim
2. `git -C <main clone> fetch origin && git merge --ff-only origin/develop` して `git push origin main`
   (main と develop が分岐していたら ff できない → 中止して人間に返す)
3. Excubitor: develop 版を stop → main 版を start
4. `confirm_runs.status = confirmed`、 Memoria の確認タスクを done に
5. testing release

## 8. 実装スコープ

- [ ] `src/db/schema.ts`: `confirm_runs` テーブル
- [ ] `src/db/confirm-runs-repo.ts`
- [ ] `src/memoria/client.ts`: Memoria へのタスク作成 / 完了 (POST /api/tasks, PATCH /api/tasks/:id)
- [ ] `src/excubitor/client.ts`: サービス一覧 / control / liveness (port 17332)
- [ ] `src/release/confirm-service.ts`: start / ok / ng の状態機械 (git 同期・ビルド・排他切替・切り戻し)
- [ ] `src/release/clone-paths.ts`: main / develop クローンのパス解決
- [ ] `src/pr/reconcile.ts`: develop への merge 検知 → confirm_runs + Memoria タスク
- [ ] `src/discord/commands/confirm.ts`: `/confirm list|start|ok|ng`
- [ ] `src/api/confirm.ts`: `/v1/confirm/*` (Discord コマンドはこれを叩く)
- [ ] Excubitor 側: develop クローンを検出して `<code>-develop` を catalog に生やす (別 PR)
- [ ] セットアップ: 全リポに `develop` ブランチ + develop クローンを用意するツール

## 9. 要確認 / 未決

- **ビルドコマンドの正本**: Excubitor catalog に `build_command` は無い。 リポごとに
  `npm run build` があるとは限らない。 当面は `package.json` に `build` script があれば
  `npm ci && npm run build`、 無ければビルド無しで起動する。
- **main と develop が分岐した場合**: `/confirm ok` は ff-only で失敗させ人間に返す
  (勝手に merge commit を作らない)。 hotfix を main に直接入れた場合はここで気付ける。
- **起動を伴わないリポ** (ライブラリ等) は `service_code` が null。 `/confirm ok` で
  develop → main 反映だけ行う。
