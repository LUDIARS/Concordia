---
task: director-genius-card-validation
project: Concordia
kind: 実装
status: done
created: 2026-08-09
memory_links:
  - spec/tasks/2026-08-09-director-script-flow.md
  - spec/feature/inquiry.md
---
# 保存済み Genius 判断カードを検証して読み出す

## 目的

SQLite に保存した `genius_cards_json` を読出す際、JSON として解釈できるだけではなく、Director が
利用する判断カード配列の形状であることを検証する。不正データを判断根拠として扱わない。

## 実装・確認事項

- `src/director/repo.ts` の `readCards` に、配列・必須フィールド・型の検証を追加する。
- JSON 構文エラー、オブジェクト、欠損フィールド、未知の型を fail-closed で扱う。
- 不正な保存値が case 詳細 API や判断処理をクラッシュさせず、監査可能な扱いになることをテストする。
- 正常な Genius 判断カードの後方互換読出しをテストする。

## スコープ

- src/director/repo.ts
- src/director/repo.test.ts
- src/director/types.ts
- spec/tasks/
