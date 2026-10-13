---
task: domain-review-authoring-bridge
project: Concordia
kind: 実装
created: 2026-09-05
memory_links: []
---
# ドメインへの指摘を Anatomia の authoring へ渡す

設計正本: 上位計画 `2026-09-05-anatomia-domain-plan-tool.md` §8.2 C-6、
および `spec/feature/domain-review-discord.md` §4。
実装は PR #1405 の `DomainReviewService.recordReply` と `domain_review_answers`。

## 目的

Discord のドメインレビュー投稿へ返ってきた「ドメイン説明の修正」「紐付け指示」を、
Cc の台帳に溜めるだけで終わらせず Anatomia のドメイン定義へ反映できるようにする。

PR #1405 では **意図的に配線していない**。理由は Anatomia 側に受け口が無いこと:

- authoring の入口は `POST /api/projects/:id/domain-organization/gate-a` だけで、
  これは `DomainProposal[]` 一式 + `expectedHead` + `sourceRevision` / `analysisSnapshotId` を
  要求する**承認ゲート**であり、自由文の指摘を受ける口ではない。
- 提案そのものは `POST .../proposals/spec` などサーバ側が生成する。人間が書いた文章を
  提案へ翻訳する工程が要るが、**Cc は LLM を内包しない**ので Cc 単独では埋められない。

したがって偽の配線を作らず、`domain_review_answers` に `kind: "domain-note"` で残すところまでを
PR #1405 の範囲とした。本タスクはその続き。

## 完了条件

Actio: actio:d972ca17-ff30-4bfe-b223-e107dce0ce15 (a1118ba2)。設計: `spec/feature/domain-review-discord.md` §4.2。

- [x] 前提: Anatomia 側に「指摘をドメイン定義のレビュー材料として受け取る」口がある
      (`POST /api/projects/:id/domain-organization/proposals/review-notes`。domainId 省略 =
      プロジェクト全体は Anatomia #2849、マージ待ち)。
- [x] `kind: "domain-note"` の回答が Anatomia へ渡り、Gate A の承認待ち提案として人間が見られること
      (`src/domain-review/note-delivery.ts`。先頭指定 `ドメイン名: 本文` で宛先が決まる)。
- [x] 宛先ドメインが決まらなければ Discord の返信先に選択ダイアログ (ドメイン 24 件 + プロジェクト全体) を出す。
      選べるのは返信者本人か回答権限のある人だけ。
- [x] 渡せなかった回答は Cc の台帳 (`domain_review_note_deliveries`、migration 134) に理由付きで残り、
      ログから追えること (無言で捨てない)。再配送と `POST /v1/domain-review/answers/:id/note-delivery/retry` で再試行できる。
- [x] 二重クリック・再配送で二重送信しない (台帳の `sending` 占有と `sent` / `rejected` の終端)。
- [x] plan 起点 (`plan-question`) の既存挙動は変えない。
- [x] `spec/feature/domain-review-discord.md` §4 の「配線しない理由」を実装後の姿に書き換える。
- [ ] 追加・変更したテストのみ実行して緑 (テスト実行は人の許可待ち。PR 時点では型チェックのみ)。

## スコープ外に触れた理由

- 選択ダイアログのため `src/discord/domain-review-note-{choice,interaction}.ts` を新設し、
  `src/discord/bot.ts` / `src/discord/ingress.ts` に配線した (返信への応答に部品を載せる口と interaction の振り分け)。
- 台帳のため `src/db/schema.ts` / `src/db/migration-ledger.ts` に migration 134 を追加した。

## 関連 (このタスクではやらない)

- 📑 / 🪬 のリアクションワークフロー、スキル一覧 API、RWF 設定画面 (設計書 C-7〜C-11) は別委託。
  `src/platform/reaction-workflow.ts` には触らない。
- LLM を使ったインタラクティブレビュー (設計書 §9.1) は Castra の `domain-review` スキル側の責務。

## スコープ (編集可ディレクトリ)

- `src/domain-review/`
- `src/db/domain-review-repo.ts`
- `src/api/domain-review.ts`
- `spec/feature/domain-review-discord.md`
