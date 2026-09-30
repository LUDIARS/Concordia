---
task: 2026-09-30-consult-intake
project: Concordia
kind: 実装
created: 2026-09-30
memory_links: []
---
# 技術相談の事前ヒアリング (知りたいこと・技術レベル・役職・目的)

設計正本: `spec/feature/tech-consultation.md` §3 (`SPEC-CONSULT-INTAKE`)。director case `dir_687ecaf4` plan v1 承認済み。

## 目的

技術相談課の回答が相手に合った粒度になるよう、回答を始める前に 4 項目を必ず揃え、起動時の前提として渡す。

## 完了条件

- [ ] ユースケースに事前ヒアリング (on / off) を持たせ、一問一答 Q&A・壁打ち相談の既定を on にする。マニュアル画面で切り替えられる。
- [ ] 部署フォーラムへの投稿で、本文から 4 項目を読み取り、欠けた必須項目と目的をスレッドで 1 回にまとめて聞き返す。必須が揃ってから起動する。
- [ ] 目的は任意だが必ず問い、「知ること自体が目的」を正当な答えとして扱う。
- [ ] 技術レベル・役職を依頼者メモに保存し (`requester_profiles.role_title` を追加)、次回の既定値にする。
- [ ] 4 項目が起動時の対話前提ブロックに「今回の相談」として入る。
- [ ] `consultation_intakes` の migration、repo、domain policy、Discord 面のテストを同じ変更で書き、`cc.acceptance.json` に対応付ける。
- [ ] ヒアリング内容を連合・通知・ログへ出さない (CC-CONSULT-INV-05)。

## スコープ (編集可ディレクトリ)

- `src/dialogue/`、`src/db/` (use-cases・requester-profiles・consultation-intakes の repo と schema / migration)、`src/api/use-cases.ts`・`src/api/requester-profiles.ts`
- `src/discord/` (部署フォーラムからの起動と聞き返し)、`web/src/pages/manuals/`、`web/src/pages/RequesterProfiles*`
- `tests/`、`spec/feature/tech-consultation.md`、`spec/feature/dialogue-context.md`
