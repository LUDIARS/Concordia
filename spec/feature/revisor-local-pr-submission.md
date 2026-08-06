---
type: feature
title: "レビュー発火 — 作業ブランチの local PR 自動提出"
description: "セッション終了時に作業ブランチを Revisor の local PR として自動提出する。提出可否は純関数で判定し理由付きでスキップする。提出時に session_id を binding し、審査の終局結果だけが提出元セッションへ戻る。"
service: concordia
domain: revisor-local-pr
owner: Concordia
tags:
  - revisor
  - local-pr
  - review-trigger
  - session-lifecycle
status: implemented
related:
  - ./revisor-test-forum-sync.md
  - ./pr-queue.md
  - ./pr-local-gate.md
updated: 2026-08-03
---

# レビュー発火 — 作業ブランチの local PR 自動提出

## 1. なぜ必要だったか

レビューの自動発火は元々こうだった (`src/pr/reconcile.ts`):

```
GitHub PR が open × session 作成 × CI success × Revisor check 未付与
  → POST /v1/pr-gate/jobs
```

しかし Revisor が local PR ワークフローへ移行した結果、 この経路は **3 箇所すべてで
切れていた**:

| 層 | 状態 |
| --- | --- |
| Cc の PR reconciler (発火元) | Excubitor catalog で `CONCORDIA_PR_RECONCILE_ENABLED: "0"` = そもそも動いていない |
| `CONCORDIA_REVISOR_TOKEN` | どこにも注入されていない |
| Revisor の `POST /v1/pr-gate/jobs` | **エンドポイントごと撤去済み** |

さらに Revisor の push-guard が feature ブランチの push を禁止したため、 登録済みリポでは
GitHub PR 自体が作られない。 つまり旧経路は設計ごと役目を失っており、 **自動でレビューが
走る経路が 1 つも存在しない**状態だった (人が手で local PR を提出したときだけレビューされる)。

本機能はその置き換えで、 **セッションの作業ブランチを Revisor の local PR として提出する**。

## 2. 発火

`session.ended` イベントを購読して提出する (`src/bootstrap/core.ts`)。
設定 `admin.revisor_auto_submit_enabled` (既定 **true**) で止められる。 既定を true に
するのは、 レビュー発火が黙って無くなる状態をもう作らないため。 切り替え口は
`GET/PUT /v1/admin/revisor-auto-submit { enabled }` (`/v1/admin` snapshot にも載る)。
購読側が発火のたびに live 評価するので再起動は要らない。

手動口として `POST /v1/prs/local { session_id }` も生やす。 セッション終了を待たずに
レビューへ出したいときに使う。 提出しなかった場合も 200 で理由を返す。

## 3. 判定 (`planLocalPrSubmission`, 純関数)

スキップは必ず**理由付き**で返す。 無言スキップは、 発火経路が死んでいても誰も気づけない
状態を作る (それが今回の元の障害そのもの)。

| 理由 | 条件 |
| --- | --- |
| `no_branch` | セッションにブランチが無い |
| `repository_not_registered` | Revisor に未登録のリポジトリ (`GET /v1/repositories` と突合) |
| `on_base_branch` | 作業ブランチが base ref と同じ (大文字小文字は無視) |
| `no_commits` | `base..branch` にコミットが無い |
| `already_open` | 同じ repo + head ブランチの local PR が queued/running/test_ok (二重提出しない) |

同じ open PR が `failed` / `action_required` の場合、手動で別の retry API を探させず、同じ
提出操作が `POST /v1/local-prs/:id/retry` へ進む。Revisor が head 前進と再審査範囲を判定する。

repository 名と base ref の照合は大文字小文字を無視する。 head ブランチ名だけは git と
同じく大文字小文字を区別する。

### repository 名の正規化

`sessions.repo_origin` は hook が `git config --get remote.origin.url` をそのまま格納する
ため、 `https://github.com/LUDIARS/Concordia.git` / `git@github.com:LUDIARS/Concordia.git`
の形で来る。 一方 Revisor の登録は `owner/repo`。 **突合前に双方を
`normalizeRepoOrigin` で `owner/repo` へ寄せる** (`findRegistration`)。 これを怠ると
どのセッションも `repository_not_registered` になり、 「自動レビューが無言で 1 件も
発火しない」 — この機能が潰しに来た障害そのものが再発する。

## 4. 提出内容

- `title`: `base..branch` の**最新コミット件名** (200 文字で切り詰め)
- `body`: セッション ID + コミット件名一覧
- `author`: `concordia`
- `session_id`: 提出した Concordia セッション ID。Revisor はこれを PR に保存し、審査が
  終局状態になった時だけ `session.inject` をそのセッションへ送る。`failed` /
  `action_required` なら原因を修正して再提出するよう促し、`test_ok` なら Revisor が
  自動マージ可否を判定してから最終結果を送る。進行中の状態通知や提出元による
  ポーリングは不要。 binding は**提出時に確定する**ので、 同じブランチで既に open な
  local PR がある場合 (`already_open`) は再 binding されず、 結果は最初に提出した
  セッションへ戻る。
- `base_ref`: Revisor の登録値をそのまま使う (Cc 側では推測しない)

head SHA / base SHA は **Revisor が自分で解決する** (`inspectLocalPullRequest`)。 Cc は
リポジトリ名と head ブランチだけ渡す。 worktree が汚い等の検証も Revisor 側の責務で、
Cc はその失敗を理由として記録する。

## 5. 失敗の扱い

提出処理は例外を投げない。 失敗は `{ submitted: false, reason: "error", detail }` として
返し、 warn ログに残す。 **セッション終了処理をレビュー発火の失敗で壊さない**。

## 6. token

Revisor の読み取り (`GET /v1/repositories` / `GET /v1/local-prs`) は loopback 限定で
token 不要。 提出 (`POST /v1/local-prs`) は変更系なので token が要る。 token が無い環境では
提出だけが失敗し、 その理由がログに残る。

token の正本は **DB (`revisor_config.workflow_token_enc`、 secret-box で暗号化)**。
設定画面 (`/v1/admin/revisor/config`) から入れる。 env `CONCORDIA_REVISOR_WORKFLOW_TOKEN` は
フォールバックとして残す (bootstrap 用)。 Discord / Slack の bot token と同じ扱いに揃えたのは、
env だけだと配布のたびにプロセス再起動が要り、 平文の置き場所も増えるため。

クライアントは token を保持せず **リクエストごとに解決**する (`resolveRevisorWorkflowToken`)。
設定画面で入れた値がその場から効く。

## 7. 実装ファイル

- `src/pr/revisor-local-pr-client.ts` — local PR API クライアント (登録一覧 / PR 一覧 / 提出)。
  ポート解決は Excubitor catalog が正本 (port-source-rule)
- `src/pr/local-pr-submission.ts` — 判定 (純関数) と提出の実行
- `src/pr/branch-commits.ts` — `base..branch` のコミット件名読み取り (読み取り専用 git、
  5 秒タイムアウト・50 件上限、 revision/path 曖昧回避の末尾 `--`、 先頭 `-` 等の
  ref をオプションとして解釈させないための ref 検証)
- `src/api/prs.ts` — `POST /v1/prs/local`
- `src/api/register-core.ts` — `GET/PUT /v1/admin/revisor-auto-submit` (安全弁)
- `src/bootstrap/core.ts` — `session.ended` 購読と手動口の配線
