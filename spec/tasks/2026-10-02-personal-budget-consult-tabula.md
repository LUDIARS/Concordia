---
task: 2026-10-02-personal-budget-consult-tabula
project: Concordia
kind: 実装
created: 2026-10-02
memory_links: []
---
# 個人の AI 予算 B — 技術相談と Tabula 公開の報奨、子会社の公開候補

設計正本: `spec/feature/personal-ai-budget.md` §4・§4.1 (`SPEC-PBUDGET-REWARD` / `SPEC-PBUDGET-TABULA-SUBSIDIARY`)、
`spec/feature/tech-consultation.md` §5・§6。価値 UX-CC-W8、UX-CC-W6。ドメイン `consultation` (依頼側) と
`personal-ai-budget` (支援)。前提: `2026-10-02-personal-budget-core` がマージ済み。
2026-10-02 neco 指示「Tabula の取り込みと技術相談課についても報酬を用意」。

着手の前提 (人の確認): 子会社の相談の要約を Tabula のメンバー共有に載せてよいか (spec §9)。確認が取れるまでは
`consultation` の報奨だけを実装し、子会社の公開候補と `tabula` の報奨は着手しない。

## 目的

技術相談課を使った人と、相談の知見を Tabula に公開した人へ報奨を付ける。子会社の相談でも公開候補を出せるようにする。

## 完了条件

- [ ] 事前ヒアリングを経て起動した技術相談のセッションが終了した時点で、相談者へ種類 `consultation` の報奨を依頼する。
      根拠は相談の受付 id。1 人 1 日 1 回 (歯止めの判定は純関数)。
- [ ] 公開候補を本人が承認し Tabula への投稿が成功した時点で、相談者へ種類 `tabula` の報奨を依頼する。根拠は公開候補の id。
- [ ] 報奨は personal-ai-budget の port へ依頼するだけにし、consultation から台帳を直接書かない。
- [ ] (確認後) 子会社の相談で `/consult wrap` を使えるようにする。候補は Cc が相談の記録から作る (相談セッションへは依頼しない。
      CC-CONSULT-INV-07 を変えない)。公開・公開しないを決められるのは相談者本人だけ (CC-CONSULT-INV-04)。
- [ ] `spec/feature/tech-consultation.md` §6 の「子会社では公開候補を出さない」を、実装に合わせて書き換える。
- [ ] 単体・結合テストを同じ変更で書き、`cc.acceptance.json` に対応付ける。実行は指示があるまでしない。

## スコープ (編集可ディレクトリ)

- `src/consultation/`、`src/discord/consult-*`、`src/discord/commands/consult.ts`、`src/api/consultations.ts`、`src/bootstrap/core.ts` (port の組み立て)
- `tests/`、`cc.acceptance.json`、`spec/feature/tech-consultation.md`、`spec/feature/personal-ai-budget.md`
