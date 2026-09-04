---
task: team-card-kinds-review-delay-adjust
project: Concordia
kind: 実装
created: 2026-09-04
memory_links:
  - spec/tasks/2026-09-04-team-management-surface.md
  - spec/tasks/2026-08-14-team-surface-card-routing.md
---
# チームカードの kind に `review` / `delay` / `adjust` を足す

## 目的

Actio `spec/feature/team-task/spec.md` §8.3 / §16.3、§10「Cc 側変更 2 / 6」。
`POST /v1/teams/:id/cards` の `kind` は固定集合で、現状は `standup` / `meeting` /
`task-kanban` / `issue-hypothesis` を受け付ける。
Actio が出す 3 種の報告に対応する kind と、それぞれの面割り当てが必要。

| kind | 面 | 用途 |
|---|---|---|
| `review` | direction | 判定キューの提示 (番号付き) |
| `delay` | 管理 (権限者限定) | 遅延レポート (§7) |
| `adjust` | 管理 (権限者限定) | 調整提案 (§16.3)。番号返信で accept/reject |

## 完了条件

- `kind` の既存 4 種を保ったまま固定集合に `review` / `delay` / `adjust` が加わり、
  未知の kind は従来どおり拒否される。
- `src/shared/team-card-routing.ts` が上記の面割り当てを行う
  (`review`→direction、`delay`/`adjust`→management)。
- 管理面が未プロビジョニングのチームへ `delay` / `adjust` を投げた場合、
  `POST /v1/teams/:id/cards` はイベントを受理する前に非 2xx と理由の分かるエラーを返す。
- 本文が Discord embed の上限を超える場合は既存の切り詰め規則に従う
  (要約とディープリンクの先頭配置は Actio 側の責務なので Cc では加工しない)。
- API validation / event schema / Discord renderer / 面割り当ての全てが 3 種を扱い、
  管理面欠落時にイベントを emit しないことを含む単体テストが green。

## 依存

`2026-09-04-team-management-surface` (管理面のプロビジョニング) が先。
