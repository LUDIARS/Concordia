---
task: director-authority-fallback
project: Concordia
kind: 実装
status: done
created: 2026-08-09
memory_links:
  - spec/tasks/2026-08-09-director-script-flow.md
  - spec/feature/director.md
  - spec/feature/inquiry.md
---
# Genius 不在時の Director 判断を人間へエスカレーションする

## 目的

Director が authority または scope の判断を必要とする際、Genius の判断カードを取得できなければ
`self_judge` へ降格せず、人間判断を要求する状態へ遷移させる。原稿フローにおける判断境界を
自動実装から隔離する。

## 実装・確認事項

- `src/director/service.ts` の `authority` / `scope` に限り、Genius 不在時のフォールバックを
  `ask_human` とする。
- `authority` / `scope` のみを `ask_human` にする例外ポリシーを Director の feature spec に明記し、
  通常の Genius 不在時の `self_judge` と区別する。
- 判断を保留した case / step が `blocked` のままになり、Director が後続工程を進めないことを保証する。
- Genius 利用可、判断カードなし、Genius 利用不可の各経路を service のユニットテストで検証する。
- 判断カードの取得不能理由を監査レコードへ残し、利用者が人間判断へ引き継げるようにする。

## スコープ

- src/director/service.ts
- src/director/service.test.ts
- src/director/repo.ts
- src/director/repo.test.ts
- src/director/types.ts
- src/db/schema.ts
- spec/feature/director.md
- spec/tasks/
