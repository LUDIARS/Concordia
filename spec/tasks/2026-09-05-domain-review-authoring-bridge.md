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

- [ ] 前提: Anatomia 側に「自由文の指摘を提案の下書きへ変換する」または「指摘をドメイン定義の
      レビュー材料として受け取る」口があること。**無ければこのタスクは着手せず、
      Anatomia 側の作業として起票し直す** (Cc 側で推測して埋めない)。
- [ ] `kind: "domain-note"` の回答が Anatomia へ渡り、Gate A の承認待ち提案として人間が見られること。
- [ ] 渡せなかった回答は Cc の台帳に残り、理由がログから追えること (無言で捨てない)。
- [ ] `spec/feature/domain-review-discord.md` §4 の「配線しない理由」を実装後の姿に書き換える。
- [ ] 追加・変更したテストのみ実行して緑。

## 関連 (このタスクではやらない)

- 📑 / 🪬 のリアクションワークフロー、スキル一覧 API、RWF 設定画面 (設計書 C-7〜C-11) は別委託。
  `src/platform/reaction-workflow.ts` には触らない。
- LLM を使ったインタラクティブレビュー (設計書 §9.1) は Castra の `domain-review` スキル側の責務。

## スコープ (編集可ディレクトリ)

- `src/domain-review/`
- `src/db/domain-review-repo.ts`
- `src/api/domain-review.ts`
- `spec/feature/domain-review-discord.md`
