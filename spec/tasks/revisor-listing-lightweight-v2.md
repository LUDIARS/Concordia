---
task: revisor-listing-lightweight-v2
project: Concordia
kind: 実装
status: review
created: 2026-10-02T00:00:00.000Z
source_session: lictor-9402fc25-33ed-4d5d-a614-decfbbc80fe2
memoria_task_id: null
pr_number: null
actio_task_id: 8c45365b-da71-4010-93ee-010705cab741
memory_links: []
---
# Revisor 一覧取得の軽量化 (残り) を #2263 の上に載せ直す

設計正本: `spec/feature/revisor-local-pr-submission.md` の Open PR discovery (CC-RV-OPEN-LIST-01) 節と
CC-RV-LIST-SCOPE-01 節。タスク参照: `actio:8c45365b-da71-4010-93ee-010705cab741`。

## 完了条件

- [x] C-1 PR 提出の照合が全件の詳細一覧に依存しない
- [x] C-2 一覧取得の失敗理由が区別して返る
- [x] C-3 #2263 の一覧の挙動 (open は full、閉じた PR は summary) が変わらない
- [x] C-4 goal-machine / マージ確認 / test forum のマージ操作の挙動が変わらない
- [x] cc.acceptance.json の implementations に source / tests を対応付けた
- [ ] テストの実行 (指示待ち)

## スコープ (編集可ディレクトリ)

- `src/pr/` (Revisor クライアント・提出の照合・失敗分類・ブランチ照合)
- `src/api/prs.ts` (`error_reason`)、`src/taskflow/goal-machine.ts`
- `web/src/api.ts` (型のみ)
- `spec/feature/revisor-local-pr-submission.md`、`spec/domains/revisor-local-pr.domain.json`、`augur.contracts.json`、`cc.acceptance.json`

## やらないこと

- #2263 の `RevisorClient.listLocalPrs` の方式変更 (重ね合わせを純関数へ切り出しただけ)
- Revisor 側 API の変更、WebUI の表示変更
- 停止検知 (`src/bootstrap/core.ts` の stalled nudge) の切替 — 委託範囲外。残作業として報告する

## PR 内容

### 概要

マージ済みの #2263 (一覧は open を詳細・閉じた PR を要約で読む) の上に、取り下げた #2258 の残りを載せ直す。
PR 提出の照合を全件の詳細一覧から外し、一覧取得の失敗理由を区別し、goal-machine の PR 照合が要約の空の
headRef で壊れないようにする。

### 変更点

- 提出 (`POST /v1/prs/local`) の二重提出照合: `listLocalPullRequests({ repository })` は open の要約一覧
  (`view=summary&state=open`、約 10 KB) から提出先リポジトリの PR を選び、その分だけ単一取得で詳細を読む。
  未登録リポジトリでは一覧を読まない。結果不明時の再照合も同じ経路。リポジトリ指定の無い呼び出し
  (セッションの PR 操作・GitHub tracker) は従来の `state=open` 詳細一覧のまま。
- 失敗理由: `src/pr/revisor-http.ts` の `RevisorRequestError.reason` で `timeout` / `unreachable` /
  `http_error` / `invalid_response` を区別。local PR クライアントと `RevisorClient` の一覧取得がこれを使い、
  `GET /v1/prs/revisor` は `error_reason` を返す。エラー応答のメッセージ形 (`failed (<status>)`) は保つ。
- goal-machine: `RevisorLocalPrReader.findLocalPrByBranch` (任意) を追加。open の詳細で探し、無ければ同じ
  リポジトリの直近の決着済み PR (最大 10 件) を単一取得で headRef 照合する。#2263 以降、決着済みの行は
  headRef が空なので、従来の一覧照合ではマージ済みの作業 PR を「PR 無し」と取り違えていた。
- #2263 の一覧: `listLocalPrs` の重ね合わせ部分を `overlayOpenDetails` に切り出しただけで挙動は同じ。

### #2258 から移したもの / 移さなかったもの

- 移した: 失敗理由の分類 (`revisor-http.ts`)、提出照合のリポジトリ限定 (候補選びは
  `revisor-repository-open-prs.ts` に分離)、ブランチ照合 (`revisor-branch-lookup.ts`)、goal-machine の切替、
  `error_reason`。
- 移さなかった: `revisor-list-query.ts` (path 組み立て)、`revisor-local-pr-rows.ts` (行の写像の移設) —
  #2263 の `revisor-client.ts` を重ねて書き換えることになるため。`bootstrap/core.ts` の停止検知の切替 —
  タスクの 3 点に含まれないため (残作業として報告)。#2258 のテストはそのまま貼らず、main の形に合わせて書き直した。

### 再利用探索

- 採用: `listOpenLocalPrsForRepository` (local-pr-lookup.ts) を提出の候補選びに流用 (リポジトリ同定規則を増やさない)。
- 採用: 単一取得 API (`/v1/local-prs/:id`、CC-RV-TARGET-01) を候補の詳細・決着済み PR の照合に流用。
- 採用: `toLocalPr` (revisor-client.ts) をブランチ照合の行写像に流用。
- 不採用: `revisor-read-cache` 系の TTL キャッシュ。提出時の照合に古い一覧を混ぜたくないため。

### 変更境界と復旧

- 変更境界: Concordia の Revisor 読み取り経路 (`src/pr/*`)、`/v1/prs/revisor` の応答 (フィールド追加のみ)、
  goal-machine の照合。Revisor 側 API・DB は変更なし。
- 復旧: この PR の revert。

### 検証

- 実施: 型チェック。`tsc --noEmit -p .` (src 全体) はエラー 0 件。`tsc --noEmit -p tsconfig.test.json` でも変更したファイル (テスト含む) にエラーは無い。
- 未実施: vitest の実行 (委託条件によりテスト実行は指示待ち)。Augur 契約の観測もテスト実行後になる。
