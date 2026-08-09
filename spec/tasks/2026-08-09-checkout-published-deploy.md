---
task: checkout-published-deploy
project: Concordia
kind: 実装
created: 2026-08-09
memory_links:
  - ../../Revisor/spec/feature/checkout-publication.md
---

# checkout_published を受けて deploy へ繋ぐ

## 目的

main が前進してもサービスは古いプロセスのまま動く。2026-08-09 の Genius がその状態で、
local PR #364 と #47 がマージ済みなのに稼働中のプロセスは `cd190cb` のビルドだった。

Revisor は「降ろすところまで」で終える設計なので、build と再起動へ繋ぐのは Cc の担当。
`cc-deploy` の経路が既にあるので、それを起動する。

## 完了条件

- Revisor の lifecycle event `checkout_published` を購読する
  (通知経路は既存の Revisor → Cc inject を再利用し、新しい通信路を作らない)。
- 対象リポに Excubitor 登録のサービスがある場合だけ deploy フローへ繋ぐ。
  サービスが無いリポでは何もしない (静かに終わってよい)。
- 起動・再起動は **Excubitor 経由・プロジェクト本体フォルダのみ・testing claim 付き**。
  このルールは変更しない。worktree からは起動しない。
- deploy を実行したか・しなかったかを、理由付きで 1 行残す。
  「main は進んだがサービスは古いまま」を無言にしない。
- build 失敗や再起動失敗は、**マージや checkout 前進を巻き戻さない**。
  失敗として報告するだけにする (3 つの段階を別々に見えるようにする)。

## スコープ (編集可ディレクトリ)

- `src/` (taskflow / deploy 連携)
- `spec/feature/`
- `src/**/*.test.ts`

## Non-goals

- 自動マージや自動 checkout 前進の判断 (Revisor 側の責務)。
- 再起動可否の判断ルールの変更 (共有インフラの lifecycle ルールはそのまま)。
