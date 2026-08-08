---
task: director-audit-ordering
project: Concordia
kind: 実装
created: 2026-08-09
memory_links:
  - spec/tasks/2026-08-09-director-script-flow.md
---
# Director 監査履歴の順序を決定的にする

## 目的

同一ミリ秒に保存された Director の監査レコードでも、UUID の偶然の順序に依存せず、発生順を
一意かつ再現可能に読めるようにする。

## 実装・確認事項

- `src/director/repo.ts` の監査記録と一覧取得に、時刻衝突時の明示的な順序キーを導入する。
- 既存データとの互換性と migration の安全性を確認する。
- 同一時刻の複数レコードを使い、監査履歴の順序が常に一定であることをテストする。

## スコープ

- src/director/repo.ts
- src/director/repo.test.ts
- src/db/schema.ts
- spec/tasks/
