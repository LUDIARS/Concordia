---
type: feature
title: "checkout lock 照会 API — 登録 checkout を前進させてよいかを Cc が答える"
description: "Revisor がマージ済み main を登録 checkout へ fast-forward で降ろす前に叩く読み取り専用の照会。session claim と testing claim を持つ Concordia が可否・理由・掴み手を返す。claim は取らず、判断材料が無いまま allowed:true を返さない。"
service: concordia
domain: checkout-lock
tags:
  - revisor
  - checkout
  - claim
  - safety
status: implemented
related:
  - feature/testing-traffic.md
  - feature/pr-local-gate.md
  - ../../Revisor/spec/feature/checkout-publication.md
updated: 2026-08-21
---

# checkout lock 照会 API

## 背景

Revisor はマージ済みの base ref を登録 checkout (`repository.rootPath`) へ
fast-forward で降ろす (Revisor `spec/feature/checkout-publication.md`)。だが Revisor は
「いまその checkout を誰が掴んでいるか」を知らない。単独で判断させると、main で作業中の
セッションの足元を更新してしまう。

session claim と testing claim を持っているのは Concordia だけなので、**可否判断は Cc が返す**。
Revisor 側の実行条件 §2-6 がこの照会にあたる。

## 契約

```
GET /v1/checkouts/lock?repo_origin=<canonicalOrigin>&repo_path=<path>&branch=<ref>
```

| クエリ | 必須 | 意味 |
|---|---|---|
| `repo_origin` | ✔ | userinfo を含まない正規化済み識別子 (`Owner/Repo`、または資格情報を含まない https / SSH URL) |
| `repo_path` | ✔ | 登録 checkout の絶対パス |
| `branch` | ✔ | 前進させたい base ref (`main` / `refs/heads/main` のどちらでもよい) |

### レスポンス

| 状況 | status | body |
|---|---|---|
| 掴み手なし | 200 | `{ "allowed": true }` |
| 掴み手あり | 200 | `{ "allowed": false, "reason": "...", "holders": [...] }` |
| `repo_path` / `branch` 欠落 | 400 | `{ "allowed": false, "error": "invalid_query", "detail": "..." }` |
| `repo_origin` が不正 / 資格情報付き | 400 | `{ "allowed": false, "error": "invalid_repo_origin", "reason": "credentials_present" \| "not_canonical" \| "empty" }` |
| testing claim を読めない構成 (未注入) | 503 | `{ "allowed": false, "error": "claims_unavailable" }` |
| 判断材料を取れなかった | 500 | `{ "allowed": false, "error": "internal_error" }` |

非 200 でも body に `allowed:false` を必ず載せる。呼び出し側が status を見落としても
「掴み手が居ないから降ろしてよい」と読み違えないようにするため。

### `reason` (機械可読な短い識別子)

| reason | 条件 |
|---|---|
| `session_active` | その `repo_path` を掴んでいる active session がある |
| `testing_claim_active` | その repo のサービスに testing claim (`/v1/testing/claim`) が出ている |
| `branch_in_use` | 対象 branch を作業中として登録している session がある (同 repo の別 worktree を含む) |

複数に当たるときは上の優先順で 1 つを返し、`holders` には当たった掴み手をすべて載せる。
**理由の無い拒否を返さない。**

### `holders`

人が次の手を決められる情報だけを載せる。

```json
{
  "kind": "session" | "testing_claim",
  "session_id": "sess-...",
  "task": "session.current_task (無ければ null)",
  "branch": "feat/x",
  "repo_path": "E:/Document/Ars/Concordia",
  "service": "concordia",        // kind=testing_claim のみ
  "note": "再起動確認",           // kind=testing_claim のみ
  "since": 1755735000
}
```

## 判定の中身

- **session の所属判定**は `src/control/conflict-scope.ts` の `conflictRepoKey` と同じ規則を使う
  (`target_project` 宣言 > ワークスペースルート (umbrella) 除外 > `repo_path`)。
  ワークスペースルートに居るだけで個別プロジェクトを宣言していないセッションは掴み手にしない。
- **testing claim の所属判定**は claim が service 名しか持たないため、
  (a) claim した session がその repo に居る、または
  (b) service 名が repo 名 (origin の repo 名 / checkout のディレクトリ名) と一致する、
  のいずれかで紐付ける。(b) があるので、claim を出した session が落ちた後でも
  Excubitor 上でテスト中のサービスを取りこぼさない。TTL (1 時間) 超過の claim は対象外。
- **branch 判定**は `refs/heads/` を落とした短い ref で比較する。

## 不変条件

1. **claim を取らない** (読み取り専用)。取ると Revisor 側の中止経路 (dirty / 非 ff / rebase 進行中)
   で解放漏れが起きる。
2. **判断材料が無いまま `allowed:true` を返さない。** 内部失敗は 5xx。testing claim の
   読み口が未注入の構成でも endpoint 自体は生やし、503 + `allowed:false` で fail closed する
   (404 にすると呼び出し側が「まだ未実装だから降ろしてよい」と読み違えうる)。Revisor は 5xx・到達不能・
   不正 JSON をすべて `allowed:false` として扱う (無言フォールバック禁止)。
3. **資格情報を受け取らない。** userinfo を含む origin は 400 で弾き、拒否ログにも原文を出さない。
   照会経路を secret の漏洩経路にしない。
4. ワークフロートグル (`workflowGate`) には載せない。ゲートの 409 は Revisor 側で
   `allowed:false` と区別できず、掴み手が居ないのに降ろせない状態を無言の設定差で作るため。

## 実装

| ファイル | 責務 |
|---|---|
| `src/api/checkouts.ts` | HTTP 境界 (クエリ検証・status・ログ) |
| `src/checkouts/origin-identity.ts` | `repo_origin` の検証と canonical 化、repo 名の取り出し |
| `src/checkouts/lock-evaluator.ts` | 掴み手の判定 (純関数。DB も HTTP も触らない) |

## この spec がやらないこと

- 降ろす操作そのもの (Revisor の責務)。
- 掴み手への通知や強制解放。この endpoint は状態を変えない。
- `checkout_published` 後の deploy 連携 (`cc-deploy` の領分)。
