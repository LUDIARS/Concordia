---
type: feature
title: "PR キュー (PR Queue)"
description: "複数の AI セッションが並行作成した PR を横断で 1 本のキューに集約し、review_state / ci_status による優先度順で Concordia API・MCP・Discord に出力する機能。schema v16 で追加され、stat 派生取り込み (ingest) と GitHub reconcile のハイブリッドで PR 状態を管理する。"
service: concordia
domain: governance
tags:
  - typescript
  - sqlite
  - rest-api
  - discord
  - state-machine
  - polling
  - persona
  - monitoring
status: implemented
updated: 2026-06-30
---


# PR キュー (PR Queue)

> 各 AI セッションが作った PR を横断で 1 本のキューにし、 「対応すべき順」 で
> Concordia (API / MCP) と Discord に出す機能。 schema v16 で追加。

## 1. 目的

複数の AI セッション（おのおの）が並行で PR を作る運用で、 「いまレビュー/マージ
待ちの PR がどれだけあって、 誰が作ったか」 を一望できないのが課題だった。
これを **AI が読みやすいキュー**（安定した JSON + コンパクト Markdown）にして、
Concordia の API / MCP と Discord の自動更新メッセージ / slash command に出す。

- 「おのおのが実装した」 = PR に作成セッション（= persona 名）を紐付ける。
- 「キュー的」 = `review_state` / `state` で優先度順に並べ、 ✅マージ可 → 🛠進行中
  → 🔍レビュー待ち の順で上に出す。 マージ済は履歴として畳む。

## 2. データモデル — `pr_records` (schema v16)

`src/db/schema.ts` / `src/db/pr-records-repo.ts`。 `UNIQUE(repo_origin, number)` で
1 PR = 1 行。主要カラム:

| column | 意味 |
|---|---|
| `repo_origin` | 正規化した `owner/repo`（例 `LUDIARS/Concordia`） |
| `number` / `title` / `url` / `head_branch` / `base_branch` | PR の基本情報 |
| `state` | `draft` / `open` / `merged` / `closed` |
| `ci_status` | `unknown` / `pending` / `success` / `failure` |
| `review_state` | `none` / `needs_review` / `reviewing` / `approved` / `changes_requested`（キュー優先度の核） |
| `author_session_id` / `persona_id` / `persona_name` | 誰が作ったか |
| `additions` / `deletions` / `changed_files` | サイズ（reconcile で取得） |
| `created_at` / `updated_at` / `merged_at` / `closed_at` | タイムスタンプ（秒） |

## 3. 取り込み (ingestion) — A + C ハイブリッド

### A. stat 派生（第一情報源、 エージェント改修ゼロ）
`src/pr/ingest.ts`。 `stat.collected` を購読し、 その session の最新 stat payload の
`open_prs[]`（`{ repo, number, title, branch }`）を `upsertFromStat` で UPSERT する。
`author = 報告した session`、 persona 名は `personas.findActiveBySession` で解決。
新規 PR を 1 件以上取り込んだら `pr.changed` (reason=`ingest`) を emit。

### C. GitHub reconcile（状態確定）
`src/pr/reconcile.ts`。 `open/draft` 行を持つ `repo_origin` についてのみ
`gh pr list --repo <origin> --state all --json …` を引き、 既存行に
`state` / `ci_status` / `review_state` / サイズ / `merged_at` / `closed_at` を反映する
（**新規 insert はしない** = キューは「session が報告した PR」 に閉じ、 無関係 PR を
取り込まない）。 best-effort（gh 不在/認証切れは warn のみ）。 更新があれば
`pr.changed` (reason=`reconcile`) を emit。

- `CONCORDIA_PR_RECONCILE_ENABLED=0` で無効化。
- `CONCORDIA_PR_RECONCILE_MIN`（分, 既定 10, 下限 2）で間隔。

> 方式 B（skill から明示 `POST /v1/prs`）は将来の精度向上として保留。

## 4. キュー組み立て・レンダリング（共有）

- `src/pr/queue.ts` `buildPrQueue(repo)` → `{ generated_at, counts, grouped, queue }`。
  - バケット: `ready`(approved) / `needs_review`(none, needs_review) /
    `in_progress`(reviewing, changes_requested) / `merged_recent`(履歴)。
  - flat `queue` 優先度: ready(0) → in_progress(1) → needs_review(2)、 同順位は
    ci failure を先頭 → `updated_at` 降順。
- `src/pr/render.ts` `renderPrQueueMarkdown(q)` → Markdown 1 枚。
  API digest / Discord / slash command が共有して表示一貫性を保つ。

## 5. 露出面

### Concordia API (`src/api/prs.ts`)
- `GET /v1/prs` — キュー JSON（`repo` / `author` filter 可）。
- `GET /v1/prs/digest` — `{ markdown }`（AI / Discord 共用）。
- `GET /v1/prs/list` — 生 `pr_records` 行（`state` / `repo` / `author` / `limit`）。

### MCP (`src/mcp/core-server.ts`)
- `concordia_pr_queue` ツール（`repo` / `author` 任意）。 AI が直接キューを読める。

### Discord (`src/discord/`)
- `pr-queue` チャンネル（`discord_config.pr_queue_channel_id`、 状態カテゴリ配下）に
  **自動更新の単一メッセージ**（`pr-queue-channel.ts`、 monitor-channel と同じ upsert
  方式）。 既定 15 分 tick + `pr.changed` で即時再描画。
  `CONCORDIA_DISCORD_PR_QUEUE_REFRESH_MIN` で間隔変更。
  各 active PR には **担当セッションの Discord チャンネルへのリンク**を付ける:
  `author_session_id` → `discord_session_channels` で `channel_id` を引き、 行に
  `担当 <#channelId>`（クリック可能なチャンネル mention）を出す。 終了済セッション
  （`status=ended`、 会話チャンネル削除済）と 🟣最近マージ には付けない。
  この解決は `renderPrQueueMarkdown` の任意 `mentionFor` リゾルバ経由で、 Discord
  でのみ注入する（API / MCP の出力には `<#id>` を混ぜない）。
- `/prs` slash command — その場でキュー Markdown を ephemeral 表示。

### イベント (`src/events.ts`)
- `pr.changed { reason: "ingest" | "reconcile" }` — WS / Discord 再描画トリガ。

## 5-b. Revisor local PR (WebUI `/prs`)

GitHub の PR とは別系統に、 Revisor (ローカル PR レビューサービス) の local PR を
`/prs` ページ先頭の独立セクションとして並べる。 ローカルクローン上のブランチをレビュー・
マージする仕組みなので、 GitHub 側のバケット (ready / needs review / …) には混ぜない。

- `GET /v1/prs/revisor` → `{ configured, base_url, pull_requests, error }`。
  Revisor の `GET /v1/local-prs` を Concordia が代理取得する
  (`RevisorClient.listLocalPrs()`)。 ポートは Excubitor catalog が正本 (port-source-rule)。
- `CONCORDIA_REVISOR_TOKEN` 未設定なら `configured: false` で、 セクションは描かない。
- Revisor が停止していても `200 + error` を返す — PRs ページ自体は開けるべきなので、
  GitHub 側の表示を Revisor の死で壊さない。
- 見出しと各行から Revisor の WebUI (`base_url`) を**新しいタブ**で開ける。 Revisor の
  ページは `frame-ancestors 'none'` なので iframe 埋め込みはできない (リンクのみ)。
- `checkStatus` (queued / running / test_ok / failed / action_required) をバッジ表示し、
  open と マージ/クローズ済み (details 折り畳み) に分ける。

## 6. 段階と将来

- **P1 (本 PR)**: schema v16 + `pr-records-repo` + stat 派生取り込み + reconcile tick
  + `GET /v1/prs(+digest/list)` + `concordia_pr_queue`。
- **P2 (本 PR)**: Discord `pr-queue` チャンネル自動更新 + `/prs` + `pr.changed`。
- **将来 (別 PR)**: 明示 `POST /v1/prs`（`/pr`・`merge-clean-pr` skill 連携）、
  Web ページ、 PR ごとの担当アサイン / レビュー依頼の双方向化。
