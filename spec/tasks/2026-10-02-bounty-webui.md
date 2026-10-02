---
task: 2026-10-02-bounty-webui
project: Concordia
kind: 実装
created: 2026-10-02
memory_links: []
---
# バグバウンティ 5/5 — WebUI

設計正本: `spec/feature/bug-bounty.md` §8.2 (`SPEC-BOUNTY-WEBUI`)。価値 UX-CC-W7。ドメイン `bug-bounty` (支援)。
前提: `2026-10-02-bounty-close-reward` がマージ済み。
2026-10-02 neco 指示「WebUI から見れるようにする」。

## 目的

運用担当が、報告の一覧・詳細・履歴を Cc の WebUI で見て、判定の変更・再審の決定・再試行・手動クローズを
画面から行えるようにする。

## 完了条件

- [ ] `GET /v1/bounty/reports` (状態 / プロジェクト / 会社 / 企画の絞り込み・ページング)。一覧の応答に原文と履歴を含めない。
- [ ] 企画の管理 (`spec/feature/bug-bounty.md` §0・§8.2): 一覧 (開催中・予定・終了)、作成と編集 (題名・期間・対象プロジェクト・
      受付口・案内文・報奨の上書き)、早期終了。権限者だけ。タスク 1 の企画 API と use case を呼ぶ。
- [ ] `GET /v1/bounty/reports/:id` (原文・仕分け結果・履歴・Actio タスク・PR・反映の証拠)。
- [ ] 「バグバウンティ」ページ: 一覧、詳細。残高は「個人の AI 予算」ページ (`spec/feature/personal-ai-budget.md` §7) へリンクする。権限者の操作 (判定・深刻度・自己起因の変更、再審の決定、タスク作成の再試行、
      手動クローズ) は既存の use case を呼ぶ。画面から状態を直接書かない。
- [ ] 設定画面に hotfix の 1 日の上限を出す。
- [ ] API は admin auth の配下。原文は運用担当の管理面にだけ出す。
- [ ] 画面はスクリーンショットを開いて確認する (座標や存在の assert だけで済ませない)。未確認ならその旨を PR に書く。
- [ ] 単体・結合テストを同じ変更で書き、`cc.acceptance.json` に対応付ける。実行は指示があるまでしない。

## スコープ (編集可ディレクトリ)

- `src/api/bounty*.ts`、`src/bounty/`、`src/db/bounty-*-repo.ts`、`web/src/pages/Bounty*.tsx`、`web/src/api.ts`、WebUI のルーティングとナビゲーション
- 設定定義、`tests/`、`cc.acceptance.json`、`spec/feature/bug-bounty.md`
