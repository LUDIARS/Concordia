---
title: "merge/PR の MCP ツール化と Revisor トークン一本化"
status: implemented
service: concordia
domain: revisor-local-pr
updated: 2026-08-08
---

# merge/PR の MCP ツール化と Revisor トークン一本化

「レビューのマージに権限がいるのはわかるがトークンが多すぎる。 サービスに API とは別に
MCP を用意し、 MCP 経由でマージと PR をツール的に行えるようにする」(2026-08-08 neco 指示)。

## トークン一本化

事実: Revisor は変更系 (提出・retry・登録・**merge**) をすべて workflow token 1 本で
認可している (`Revisor/src/server.mjs` の単一ゲート)。 それにもかかわらず Cc 側は
merge 用 `CONCORDIA_REVISOR_TOKEN` (env 直読み・起動時固定・どこにも注入されていない)
と提出用 `CONCORDIA_REVISOR_WORKFLOW_TOKEN` (DB 正本・secret-box・都度解決) の
2 系統を持っており、 マージボタンが実行時に必ず失敗する構図だった。

- `RevisorClient` の token をリクエスト毎解決 (`toTokenResolver`) に変更し、
  bootstrap で workflow token resolver を渡す。 設定画面の変更が再起動なしで効く。
- env `CONCORDIA_REVISOR_TOKEN` は deprecation フォールバックとして残す。

## MCP サーバ `concordia-pr` (`src/mcp/pr-server.ts`)

stdio / Cc loopback HTTP のみ / DB 直触りしない (core-server と同じ責任分界)。
**MCP クライアントはトークンを一切持たない** — 秘密は Cc 内部で解決され、 人間側の
認可は Cc endpoint の社員名簿 capability (`merge_pr`, 管理職以上) だけになる。
認可は抜かず、 トークンの配布だけを消す。

| tool | 叩き先 | 備考 |
|---|---|---|
| `pr_submit` | `POST /v1/prs/local/direct` | session 登録不要の direct 提出 (§8)。 failed/action_required は自動 retry |
| `pr_status` | `GET /v1/prs/revisor` | repository フィルタ付き一覧 |
| `pr_merge` | `POST /v1/prs/local/:id/merge` | 認可は Cc 側 (session の直近人間指示者の roster 判定)。 endpoint は feat/admin-authorized-merge (#304 系) が提供 |

## Non-goals

- `main_reconcile` ツール (GitHub main 乖離は Revisor #309 で publish 時に自動修復される
  ため手動口は不要になった)
- core-server / delegation-server の callConcordia 共通化リファクタ
  (delegation 側のタイムアウト欠如は既知の別修正)
