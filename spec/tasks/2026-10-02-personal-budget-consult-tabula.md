---
task: 2026-10-02-personal-budget-consult-tabula
project: Concordia
kind: 実装
created: 2026-10-02
memory_links: []
---
# 個人の AI 予算 B — Tabula 公開の報奨、子会社の公開候補

設計正本: `spec/feature/personal-ai-budget.md` §4・§4.1 (`SPEC-PBUDGET-REWARD` / `SPEC-PBUDGET-TABULA-SUBSIDIARY`)、
`spec/feature/tech-consultation.md` §5・§6。価値 UX-CC-W8、UX-CC-W6。ドメイン `consultation` (依頼側) と
`personal-ai-budget` (支援)。前提: `2026-10-02-personal-budget-core` がマージ済み。
2026-10-02 neco 指示「Tabula の取り込みと技術相談課についても報酬を用意」「公開したものに対して報酬」。
子会社の相談の要約を Tabula のメンバー共有に載せる点は、判断を求めた報告への neco の回答「よい」(同日) を了承として扱う。

## 目的

技術相談の知見を Tabula に公開した人へ報奨を付ける。相談しただけでは付けない。子会社の相談でも公開候補を出せるようにする。

## 完了条件

- [ ] 公開候補を本人が承認し Tabula への投稿が成功した時点で、相談者へ種類 `tabula` の報奨を依頼する。根拠は公開候補の id。
      投稿の失敗・公開しない・取り下げでは依頼しない。
- [ ] 報奨は personal-ai-budget の port へ依頼するだけにし、consultation から台帳を直接書かない。
- [ ] 子会社の相談で `/consult wrap` を使えるようにする。候補は Cc が相談の記録から作る (相談セッションへは依頼しない。
      CC-CONSULT-INV-07 を変えない)。書き直した要約で、会話の転載・個人・社内固有・秘密を含めない。
- [ ] 公開・公開しないを決められるのは相談者本人だけ (CC-CONSULT-INV-04)。承認前の候補は相談チャンネルの外へ出さない。
- [ ] `spec/feature/tech-consultation.md` §6 の「子会社では公開候補を出さない」を、実装に合わせて書き換える。
- [ ] 単体・結合テストを同じ変更で書き、`cc.acceptance.json` に対応付ける。実行は指示があるまでしない。

## スコープ (編集可ディレクトリ)

- `src/consultation/`、`src/discord/consult-*`、`src/discord/commands/consult.ts`、`src/api/consultations.ts`、`src/bootstrap/core.ts` (port の組み立て)
- `tests/`、`cc.acceptance.json`、`spec/feature/tech-consultation.md`、`spec/feature/personal-ai-budget.md`
