---
task: checkout-lock-api
project: Concordia
kind: 実装
created: 2026-08-09
memory_links:
  - ../../Revisor/spec/feature/checkout-publication.md
---

# 登録 checkout を前進させてよいかの照会 API

## 目的

Revisor はマージ済み main を登録 checkout へ fast-forward で降ろす
(Revisor `spec/feature/checkout-publication.md`、local PR #388 でマージ済み)。
しかし Revisor は「今その checkout を誰が掴んでいるか」を知らない。単独で判断させると、
main で作業中のセッションの足元を更新してしまう。

session claim と testing claim を持っているのは Cc だけなので、可否判断を Cc が返す。

## 完了条件

- `GET /v1/checkouts/lock?repo_origin=<canonicalOrigin>&repo_path=<path>&branch=<ref>`
  を追加する。
  - 許可: `200 { "allowed": true }`
  - 拒否: `200 { "allowed": false, "reason": "...", "holders": [...] }`
- `allowed:false` を返す条件:
  - その `repo_path` を claim している active session がある
  - その repo のサービスに testing claim (`/v1/testing/claim`) が出ている
  - 対象 branch を作業中として登録している session がある
- `reason` は機械可読な短い識別子にし、`holders` には session id と task 名など
  **人が次の手を決められる情報**を入れる。理由の無い拒否を返さない。
- `repo_origin` は userinfo を含まない正規化済みの識別子だけを受ける。
  資格情報付き URL を受け取ってログやイベントへ流さない。
- 読み取り専用であること。この endpoint は claim を取らない (取ると Revisor 側の
  中止経路で解放漏れが起きる)。
- 判断材料が無いまま `allowed:true` を返さない。内部エラーは 5xx で返し、
  Revisor 側が `allowed:false` として扱えるようにする。

## スコープ (編集可ディレクトリ)

- `src/api/`
- `spec/feature/` (この endpoint の契約を記載)
- `src/**/*.test.ts`
