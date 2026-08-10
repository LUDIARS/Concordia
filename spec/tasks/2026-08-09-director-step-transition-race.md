---
task: director-step-transition-race
project: Concordia
kind: 実装
status: done
created: 2026-08-09
memory_links:
  - spec/tasks/2026-08-09-director-script-flow.md
  - spec/feature/task-workflow.md
---
# Director の判断保存後遷移における競合を解消する

## 目的

判断レコードの保存と auto-block を含む step 遷移の間に別の遷移が入っても、利用者へ不必要な
409 を返さず、step と判断履歴が矛盾しないようにする。

## 実装・確認事項

- `src/director/service.ts` の判断保存後の遷移を、競合に耐える単位へ整理する。
- 同じ到達状態への重複遷移は冪等に扱い、相反する遷移だけを明確に拒否する。
- 競合時にも判断監査が失われず、case / step の最終状態を再読込で確認できるようにする。
- 競合を再現するユニットテストを追加し、409 を返すべき相反ケースも分けて検証する。

## スコープ

- src/director/service.ts
- src/director/service.test.ts
- src/director/repo.ts
- spec/tasks/
